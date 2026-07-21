// EF Pong — phone app. Faithful port of the trust-wave prototype, wired to Supabase.
// Trust wave (wave 1): magic-link login, match ownership, dispute → admin, claims.
import * as api from './api.js';
import { SUPABASE_ANON_KEY, AUTH_PROVIDERS } from './config.js';

// provider button metadata (label + Phosphor icon + brand color)
const PROVIDER_META = {
  google: { label: 'Continue with Google', icon: 'ph-google-logo', color: '#191919' },
  azure: { label: 'Continue with Microsoft', icon: 'ph-windows-logo', color: '#0067b8' },
};

// ---------- state ----------
const state = {
  season: null,
  players: [],          // leaderboard rows, sorted by elo desc (incl. email, isAdmin)
  history: [],          // rating_history rows (move indicators)
  feed: [],
  claims: [],           // sign-ins awaiting admin approval
  ratingEvents: [],     // void/penalty events affecting me (ratings-changed notes)
  rolloutComplete: false,
  screen: 'leaderboard',

  // identity / auth
  session: null,
  identity: null,       // signed-in player id
  pending: false,       // signed in, but player has no bound email / an open claim
  authStep: 'email',    // 'email' | 'sent' | 'claim'
  authEmail: '',
  creating: false,      // create-player form open in the claim step
  _newName: '',
  avatarMenu: false,

  // dispute sheet
  disputeFor: null,     // match id whose sheet is open
  disputeReason: null,  // 'score' | 'nothappen' | 'wrongplayer' | 'other'

  // log tab
  profileId: null,
  profileData: null,
  rivalId: null,
  pickerOpen: null,     // 'b' | null (Player 1 is locked to the signed-in user)
  logA: null,           // locked to state.identity
  logB: null,           // chosen opponent
  logSearch: '',        // opponent picker search query
  myMatches: [],        // signed-in user's matches -> recent opponents / games-together
  scoreA: 11,
  scoreB: 0,
  openComments: new Set(),

  toast: null,
  loading: true,
  error: null,
  busy: false,
};

let seenEvents = new Set();
try { seenEvents = new Set(JSON.parse(localStorage.getItem('efpong_seen_events') || '[]')); } catch (e) {}
function markEventSeen(id) {
  seenEvents.add(id);
  try { localStorage.setItem('efpong_seen_events', JSON.stringify([...seenEvents])); } catch (e) {}
}

// ---------- elo (preview only — the server is authoritative) ----------
const expected = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));
const marginMult = d => 1 + Math.log(Math.max(d, 1)) / Math.log(11);
function calcDelta(wElo, lElo, ws, ls, wGames) {
  const K = wGames < 5 ? 40 : 24;
  return Math.max(1, Math.round(K * marginMult(ws - ls) * (1 - expected(wElo, lElo))));
}
function validScore(a, b) {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return hi >= 11 && hi - lo >= 2 && hi <= 21;
}

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const first = name => (name || '').split(' ')[0];
const P = id => state.players.find(p => p.id === id);
const rankOf = id => state.players.findIndex(p => p.id === id) + 1;
const games = p => p.wins + p.losses;
const emailValid = e => /\S+@\S+\.\S+/.test((e || '').trim());
const me = () => (state.identity ? P(state.identity) : null);
const isAdmin = () => { const m = me(); return !!(m && m.isAdmin); };
const canAct = () => !!(state.identity && !state.pending);
// roster names a newcomer may claim: no email bound, no open claim, not the admin
const claimable = () => state.players.filter(p =>
  !p.email && !p.isAdmin && !state.claims.some(c => c.player_id === p.id));

function fmtTime(iso) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 60) return min + 'm ago';
  if (min < 1440) return Math.round(min / 60) + 'h ago';
  return Math.round(min / 1440) + 'd ago';
}

function mkInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// elo 24h ago from the audit trail -> today's movement
function eloAt(playerId, cutoffMs) {
  let last = null;
  for (const h of state.history) {
    if (h.player_id !== playerId) continue;
    if (new Date(h.recorded_at).getTime() > cutoffMs) break;
    last = h.rating_after;
  }
  return last ?? 1000;
}
function move(p) {
  const prev = eloAt(p.id, Date.now() - 24 * 3600 * 1000);
  const d = p.elo - prev;
  if (d > 0) return { icon: 'ph-fill ph-caret-up', color: '#008928', text: '+' + d };
  if (d < 0) return { icon: 'ph-fill ph-caret-down', color: '#D1334A', text: '' + Math.abs(d) };
  return { icon: 'ph-bold ph-minus', color: 'rgba(25,25,25,.35)', text: '0' };
}

const avatar = (p, size, font) => `
  <div style="width:${size}px;height:${size}px;border-radius:999px;background:${p.color};color:${p.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${font}px;flex-shrink:0">${esc(p.initials)}</div>`;

// ---------- data ----------
async function loadCore() {
  state.season = await api.getActiveSeason();
  await refreshData();
  state.loading = false;
}

async function refreshData() {
  const [players, feed, history, claims, rollout] = await Promise.all([
    api.getLeaderboard(state.season.id),
    api.getFeed(state.season.id, 30, { includeVoided: true }),
    api.supabase.from('rating_history')
      .select('player_id, rating_after, recorded_at, kind')
      .order('recorded_at', { ascending: true }).limit(5000)
      .then(r => { if (r.error) throw r.error; return r.data; }),
    api.listClaims().catch(() => []),
    api.getRolloutComplete().catch(() => false),
  ]);
  state.players = players;
  state.feed = feed;
  state.history = history;
  state.claims = claims;
  state.rolloutComplete = rollout;
  if (state.identity && !P(state.identity)) state.identity = null;
  // verified iff the player row has a bound email — auto-flips when an admin approves
  if (state.identity) state.pending = !(P(state.identity) && P(state.identity).email);
  // Player 1 is always the signed-in user
  state.logA = state.identity;
  if (state.identity) {
    state.ratingEvents = await api.getRatingEvents(state.identity).catch(() => []);
    state.myMatches = await api.getPlayerMatches(state.identity, state.season.id).catch(() => []);
  } else {
    state.myMatches = [];
  }
}

// Resolve the current Supabase session into an app identity.
async function resolveSession(session) {
  state.session = session;
  if (!session) {
    state.identity = null; state.pending = false;
    state.authStep = 'email';
    return;
  }
  const email = (session.user && session.user.email) || '';
  state.authEmail = email;
  const player = await api.resolvePlayerByEmail(email).catch(() => null);
  if (player) {                       // recognised email -> straight in
    state.identity = player.id; state.pending = false;
    state.authStep = 'email';
    return;
  }
  const claim = await api.getMyClaim(email).catch(() => null);
  if (claim) {                        // claimed a name, waiting on the admin
    state.identity = claim.player_id; state.pending = true;
    state.authStep = 'email';
    return;
  }
  state.identity = null; state.pending = false;   // new email -> claim/create step
  state.authStep = 'claim';
}

// ---------- rendering ----------
const $ = id => document.getElementById(id);

function render() {
  renderHeader();
  renderView();
  renderNav();
  renderGate();
  renderDispute();
  renderAvatarMenu();
  renderToast();
  wireLogSearch();
}

// Live opponent-search input: re-render on each keystroke, then restore focus
// and caret (the whole view is rebuilt from an innerHTML string, like the gate).
function wireLogSearch() {
  const input = $('opp-search');
  if (!input) return;
  input.addEventListener('input', () => { state.logSearch = input.value; render(); });
  input.focus();
  const n = input.value.length;
  try { input.setSelectionRange(n, n); } catch (e) {}
}

function renderHeader() {
  const idP = me();
  $('header').innerHTML = `
  <div style="background:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--hairline);position:sticky;top:0;z-index:10">
    <div style="display:flex;align-items:center;gap:9px">
      <div style="width:30px;height:30px;border-radius:8px;background:#006BD6;display:flex;align-items:center;justify-content:center"><i class="ph-fill ph-ping-pong" style="color:#fff;font-size:19px"></i></div>
      <span style="font-size:20px;font-weight:900;letter-spacing:-.5px;color:#191919">EF Pong</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      ${idP ? `<button class="tap" data-action="avatar-menu" title="Account" style="border:none;background:transparent;padding:0;width:36px;height:36px;border-radius:999px;display:flex;align-items:center;justify-content:center;position:relative"><span style="width:34px;height:34px;border-radius:999px;background:${idP.color};color:${idP.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;border:2px solid #E5F3FF">${esc(idP.initials)}</span>${state.pending ? '<span style="position:absolute;bottom:-1px;right:-1px;width:15px;height:15px;border-radius:999px;background:#FAB005;border:2px solid #fff;display:flex;align-items:center;justify-content:center"><i class="ph-fill ph-hourglass-medium" style="color:#fff;font-size:8px"></i></span>' : ''}</button>` : ''}
      <a class="tap" href="wall.html" style="text-decoration:none;border:1px solid rgba(25,25,25,.15);background:#fff;border-radius:999px;height:36px;padding:0 14px;display:flex;align-items:center;gap:6px;color:#191919"><i class="ph-bold ph-monitor" style="font-size:16px"></i><span style="font-size:13px;font-weight:700">Wall</span></a>
    </div>
  </div>`;
}

function renderNav() {
  const tabs = [
    { id: 'leaderboard', label: 'Ranking', icon: 'ph-fill ph-ranking' },
    { id: 'log', label: 'Log', icon: 'ph-fill ph-plus-circle' },
    { id: 'feed', label: 'Feed', icon: 'ph-fill ph-chat-teardrop-text' },
    { id: 'profile', label: 'You', icon: 'ph-fill ph-user' },
  ];
  if (isAdmin()) tabs.push({ id: 'admin', label: 'Admin', icon: 'ph-fill ph-shield-check' });
  const badge = state.feed.filter(m => m.status === 'disputed' && !m.isVoided).length + state.claims.length;
  $('nav').innerHTML = `
  <div style="background:#fff;border-top:1px solid var(--hairline);display:flex;padding:8px 8px calc(10px + env(safe-area-inset-bottom));position:sticky;bottom:0;z-index:10">
    ${tabs.map(t => `
      <button class="tap" data-action="nav" data-screen="${t.id}" style="flex:1;border:none;background:transparent;display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px 0;color:${t.id === state.screen ? '#006BD6' : 'rgba(25,25,25,.4)'}">
        <span style="position:relative;display:flex"><i class="${t.icon}" style="font-size:24px"></i>${t.id === 'admin' && badge > 0 ? `<span style="position:absolute;top:-4px;right:-8px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#D1334A;color:#fff;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;line-height:1">${badge}</span>` : ''}</span>
        <span style="font-size:10px;font-weight:700;letter-spacing:.2px">${t.label}</span>
      </button>`).join('')}
  </div>`;
}

function pendingBanner() {
  if (!state.pending) return '';
  return `
  <div style="margin:12px 16px 0;background:#FFF7E0;border:1px solid #F2C94C;border-radius:12px;padding:10px 13px;display:flex;align-items:center;gap:9px">
    <i class="ph-fill ph-hourglass-medium" style="color:#946A00;font-size:17px;flex-shrink:0"></i>
    <span style="font-size:12px;line-height:16px;color:#946A00;font-weight:500;flex:1">Verification pending &mdash; browse away. Logging &amp; disputing unlock once an admin approves you.</span>
  </div>`;
}

function renderView() {
  if (state.loading) {
    $('view').innerHTML = `<div style="padding:60px 20px;text-align:center;color:rgba(25,25,25,.45);font-size:14px;font-weight:300">Loading…</div>`;
    return;
  }
  if (state.error) {
    $('view').innerHTML = `<div style="margin:24px 16px;padding:20px;background:#FCE4E8;border:1px solid rgba(209,51,74,.3);border-radius:16px;font-size:14px;color:#191919"><strong>Couldn't reach the server.</strong><br><span style="font-weight:300">${esc(state.error)}</span></div>`;
    return;
  }
  const views = { leaderboard: viewLeaderboard, log: viewLog, feed: viewFeed, profile: viewProfile, admin: viewAdmin };
  const v = views[state.screen] || viewLeaderboard;
  $('view').innerHTML = pendingBanner() + v();
}

// ---------- leaderboard ----------
function viewLeaderboard() {
  const sorted = state.players;
  const hasPodium = sorted.length >= 3;
  const medals = [
    { bg: '#FAB005', text: '#191919', size: 56, font: 18 },
    { bg: '#C7CDD4', text: '#191919', size: 50, font: 16 },
    { bg: '#CD8B54', text: '#fff', size: 50, font: 16 },
  ];
  const podium = hasPodium ? [1, 0, 2].map(i => {
    const p = sorted[i], m = medals[i];
    return `
    <div class="tap" data-action="open-profile" data-id="${esc(p.id)}" style="flex:1;background:#fff;border:1px solid var(--hairline);border-radius:16px;padding:14px 8px 12px;text-align:center;position:relative;box-shadow:0 6px 18px -12px rgba(25,25,25,.4);cursor:pointer">
      <div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);width:24px;height:24px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:${m.bg};color:${m.text};font-size:12px;font-weight:900">${i + 1}</div>
      <div style="width:${m.size}px;height:${m.size}px;border-radius:999px;background:${p.color};color:${p.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;margin:8px auto;font-size:${m.font}px;border:2px solid ${m.bg}">${esc(p.initials)}</div>
      <div style="font-size:13px;font-weight:700;color:#191919;line-height:1.15;margin-bottom:2px">${esc(first(p.name))}</div>
      <div style="font-family:var(--font-mono);font-size:15px;font-weight:700;color:#006BD6">${p.elo}</div>
    </div>`;
  }).join('') : '';

  const rows = (hasPodium ? sorted.slice(3) : sorted).map(p => {
    const mv = move(p), rank = rankOf(p.id), isMe = p.id === state.identity;
    return `
    <div class="tap" data-action="open-profile" data-id="${esc(p.id)}" style="display:flex;align-items:center;gap:12px;background:${isMe ? '#E5F3FF' : '#fff'};border:1px solid ${isMe ? 'rgba(0,107,214,.4)' : 'var(--hairline)'};border-radius:14px;padding:10px 12px;cursor:pointer">
      <div style="width:22px;text-align:center;font-weight:700;font-size:15px;color:${rank <= 3 ? '#006BD6' : 'rgba(25,25,25,.4)'};flex-shrink:0">${rank}</div>
      ${avatar(p, 38, 13)}
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:15px;font-weight:700;color:#191919;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</span>
          ${isMe ? '<span style="font-size:10px;font-weight:900;color:#006BD6;background:#E5F3FF;padding:1px 6px;border-radius:999px;letter-spacing:.5px">YOU</span>' : ''}
          ${games(p) < 5 ? '<span style="font-size:10px;font-weight:700;color:#946A00;background:#FFF3D6;padding:1px 6px;border-radius:999px">NEW</span>' : ''}
        </div>
        <div style="font-size:12px;color:rgba(25,25,25,.5);font-weight:400;margin-top:1px">${p.wins}W &middot; ${p.losses}L</div>
      </div>
      <div style="display:flex;align-items:center;gap:3px;color:${mv.color};flex-shrink:0"><i class="${mv.icon}" style="font-size:13px"></i><span style="font-size:12px;font-weight:700">${mv.text}</span></div>
      <div style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:#191919;width:44px;text-align:right;flex-shrink:0">${p.elo}</div>
    </div>`;
  }).join('');

  return `
  <div style="padding:20px 16px 28px">
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px">
      <h1 style="font-size:28px;font-weight:700;color:#191919;margin:0;letter-spacing:-.5px">Leaderboard</h1>
      <span style="font-size:12px;font-weight:700;color:#006BD6;text-transform:uppercase;letter-spacing:.8px">${esc(state.season.name)}</span>
    </div>
    <p style="margin:0 0 18px;font-size:13px;color:rgba(25,25,25,.55);font-weight:300">${state.players.length} players &middot; live ranking</p>
    ${hasPodium ? `<div style="display:flex;gap:10px;align-items:flex-end;margin-bottom:22px">${podium}</div>` : ''}
    <div style="display:flex;flex-direction:column;gap:8px">${rows}</div>
    ${!hasPodium ? `
    <div style="margin-top:14px;text-align:center;padding:18px;background:#E5F3FF;border:1px dashed rgba(0,107,214,.35);border-radius:14px">
      <div style="font-size:13px;font-weight:700;color:#006BD6">Get the office on the board</div>
      <div style="font-size:12px;color:rgba(25,25,25,.6);font-weight:300;margin-top:2px">Share the link &mdash; teammates sign in and claim their name.</div>
    </div>` : ''}
  </div>`;
}

// ---------- log a match ----------
function viewLog() {
  const header = `
    <h1 style="font-size:28px;font-weight:700;color:#191919;margin:0 0 2px;letter-spacing:-.5px">Log a match</h1>
    <p style="margin:0 0 18px;font-size:13px;color:rgba(25,25,25,.55);font-weight:300">Enter the game you just played.</p>`;

  if (state.pending) {
    return `<div style="padding:20px 16px 28px">${header}
      <div style="background:#fff;border:1.5px solid #F2C94C;border-radius:16px;padding:22px 18px;text-align:center">
        <div style="width:54px;height:54px;border-radius:14px;background:#FFF7E0;display:flex;align-items:center;justify-content:center;margin:0 auto 12px"><i class="ph-fill ph-lock-simple" style="color:#946A00;font-size:26px"></i></div>
        <div style="font-size:16px;font-weight:700;color:#191919;margin-bottom:6px">Verify to log matches</div>
        <p style="font-size:13px;line-height:20px;color:rgba(25,25,25,.6);font-weight:300;margin:0">An admin needs to confirm your sign-in before you can record results &mdash; this keeps anyone from logging games as you. You'll get in as soon as they approve you.</p>
      </div></div>`;
  }

  // Signed-out (the sign-in gate overlays this screen, but render() still runs viewLog)
  if (!me()) return `<div style="padding:20px 16px 28px">${header}</div>`;

  // Section A — "You" (Player 1 is locked to the signed-in player)
  const meP = me();
  const youSection = `
    <div>
      <div style="font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:rgba(25,25,25,.5);margin:0 0 6px 2px">You</div>
      <div style="display:flex;align-items:center;gap:12px;background:#F5F5F5;border:1.5px solid rgba(25,25,25,.1);border-radius:14px;padding:12px 14px">
        <div style="width:40px;height:40px;border-radius:999px;background:${meP.color};color:${meP.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0">${esc(meP.initials)}</div>
        <span style="flex:1;font-size:16px;font-weight:700;color:#191919">${esc(meP.name)}</span>
        <span style="display:flex;align-items:center;gap:5px;color:rgba(25,25,25,.45);font-size:12px;font-weight:700"><i class="ph-fill ph-lock-simple" style="font-size:14px"></i>You</span>
      </div>
    </div>`;

  // Section B — searchable opponent picker
  const oppP = state.logB ? P(state.logB) : null;
  const open = state.pickerOpen === 'b';
  const q = (state.logSearch || '').trim();
  const lc = q.toLowerCase();
  const hasQuery = q.length > 0;
  const fieldBorder = open ? '#006BD6' : (oppP ? 'rgba(25,25,25,.1)' : 'rgba(25,25,25,.15)');
  const searchBorder = hasQuery ? '#006BD6' : 'rgba(25,25,25,.12)';

  // recent opponents = distinct opponents from my own history, most-recent first, cap 4
  const seenOpp = new Set();
  const recentIds = [];
  state.myMatches.forEach(m => {
    const oid = m.winner_id === state.identity ? m.loser_id
      : (m.loser_id === state.identity ? m.winner_id : null);
    if (oid && oid !== state.identity && !seenOpp.has(oid) && P(oid)) { seenOpp.add(oid); recentIds.push(oid); }
  });
  const topRecent = recentIds.slice(0, 4);
  const gamesVs = oid => state.myMatches.filter(m =>
    (m.winner_id === state.identity && m.loser_id === oid) ||
    (m.loser_id === state.identity && m.winner_id === oid)).length;

  const recent = topRecent.map(id => P(id));
  const rest = state.players
    .filter(o => o.id !== state.identity && !topRecent.includes(o.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const results = hasQuery
    ? state.players
        .filter(o => o.id !== state.identity && o.name.toLowerCase().includes(lc))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const rowBase = 'width:100%;display:flex;align-items:center;gap:11px;border:none;border-bottom:1px solid rgba(25,25,25,.05);padding:10px 16px;text-align:left';
  const rowAvatar = o => `<div style="width:34px;height:34px;border-radius:999px;background:${o.color};color:${o.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0">${esc(o.initials)}</div>`;
  const rowElo = o => `<span style="font-family:var(--font-mono);font-size:12px;color:rgba(25,25,25,.45)">${o.elo}</span>`;
  const rowCheck = sel => sel ? '<i class="ph-fill ph-check-circle" style="font-size:19px;color:#008928"></i>' : '';
  const rowOpen = o => `<button class="tap row" data-action="pick-player" data-which="b" data-id="${esc(o.id)}" style="${rowBase};background:${o.id === state.logB ? '#EAF4FF' : '#fff'}">`;

  const recentRow = o => {
    const n = gamesVs(o.id);
    return `${rowOpen(o)}
      ${rowAvatar(o)}
      <div style="flex:1;min-width:0"><div style="font-size:14.5px;font-weight:600;color:#191919">${esc(o.name)}</div><div style="font-size:11.5px;font-weight:400;color:rgba(25,25,25,.5)">${n} game${n === 1 ? '' : 's'} together</div></div>
      ${rowElo(o)}${rowCheck(o.id === state.logB)}
    </button>`;
  };
  const plainRow = o => `${rowOpen(o)}
      ${rowAvatar(o)}
      <span style="flex:1;font-size:14.5px;font-weight:500;color:#191919">${esc(o.name)}</span>
      ${rowElo(o)}${rowCheck(o.id === state.logB)}
    </button>`;
  const resultRow = o => {
    const i = o.name.toLowerCase().indexOf(lc);
    return `${rowOpen(o)}
      ${rowAvatar(o)}
      <span style="flex:1;font-size:14.5px;font-weight:500;color:#191919">${esc(o.name.slice(0, i))}<span style="background:#FFF1A8;font-weight:700;border-radius:3px">${esc(o.name.slice(i, i + q.length))}</span>${esc(o.name.slice(i + q.length))}</span>
      ${rowElo(o)}${rowCheck(o.id === state.logB)}
    </button>`;
  };

  const recentHeader = `<div style="padding:11px 16px 5px;font-size:10.5px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:#006BD6;display:flex;align-items:center;gap:6px"><i class="ph-fill ph-clock-counter-clockwise" style="font-size:13px"></i>Recent opponents</div>`;
  const allHeader = `<div style="padding:13px 16px 5px;font-size:10.5px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:rgba(25,25,25,.45)">All players</div>`;
  const emptyState = `<div style="padding:30px 20px;text-align:center">
      <div style="width:46px;height:46px;border-radius:13px;background:#F5F5F5;display:flex;align-items:center;justify-content:center;margin:0 auto 11px"><i class="ph ph-user-focus" style="font-size:24px;color:rgba(25,25,25,.35)"></i></div>
      <div style="font-size:14px;font-weight:700;color:#191919">No players match &ldquo;${esc(q)}&rdquo;</div>
      <div style="font-size:12.5px;font-weight:300;color:rgba(25,25,25,.55);margin-top:3px">Check the spelling, or clear the search to see everyone.</div>
    </div>`;

  let panelBody;
  if (hasQuery) {
    panelBody = results.length ? results.map(resultRow).join('') : emptyState;
  } else {
    panelBody = (recent.length ? recentHeader + recent.map(recentRow).join('') : '')
      + allHeader + rest.map(plainRow).join('');
  }

  const opponentSection = `
    <div>
      <div style="font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:rgba(25,25,25,.5);margin:0 0 6px 2px">Opponent</div>
      <button class="tap" data-action="toggle-picker" data-which="b" style="width:100%;display:flex;align-items:center;gap:12px;background:#fff;border:1.5px solid ${fieldBorder};border-radius:14px;padding:12px 14px;text-align:left">
        <div style="width:40px;height:40px;border-radius:999px;background:${oppP ? oppP.color : '#E5E5E5'};color:${oppP ? oppP.textColor : 'rgba(25,25,25,.4)'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0">${oppP ? esc(oppP.initials) : '?'}</div>
        <span style="flex:1;font-size:16px;font-weight:700;color:${oppP ? '#191919' : 'rgba(25,25,25,.4)'}">${oppP ? esc(oppP.name) : 'Select opponent'}</span>
        <i class="ph-bold ph-caret-${open ? 'up' : 'down'}" style="font-size:16px;color:rgba(25,25,25,.4)"></i>
      </button>
      ${open ? `
      <div style="background:#fff;border:1px solid rgba(25,25,25,.1);border-radius:16px;margin-top:8px;overflow:hidden;box-shadow:0 14px 34px -14px rgba(25,25,25,.5);animation:sheetIn .16s ease">
        <div style="padding:12px 12px 10px;border-bottom:1px solid rgba(25,25,25,.07)">
          <div style="display:flex;align-items:center;gap:9px;background:#F5F5F5;border:1.5px solid ${searchBorder};border-radius:12px;padding:0 12px;height:44px">
            <i class="ph-bold ph-magnifying-glass" style="font-size:17px;color:rgba(25,25,25,.45)"></i>
            <input id="opp-search" value="${esc(state.logSearch)}" placeholder="Search players" autocomplete="off" style="flex:1;border:none;background:transparent;outline:none;font-size:15px;font-weight:500;color:#191919" />
            ${hasQuery ? '<button class="tap" data-action="clear-search" style="border:none;background:rgba(25,25,25,.12);width:22px;height:22px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:#191919;flex-shrink:0"><i class="ph-bold ph-x" style="font-size:12px"></i></button>' : ''}
          </div>
        </div>
        <div class="app-scroll" style="max-height:300px;overflow-y:auto">${panelBody}</div>
      </div>` : ''}
    </div>`;

  const scName = (id, fb) => id ? first(P(id).name) : fb;
  const scoreCard = (which, name, score, winning) => `
    <div style="flex:1;background:#fff;border:1.5px solid rgba(25,25,25,.1);border-radius:16px;padding:14px 10px;text-align:center">
      <div style="font-size:13px;font-weight:700;color:#191919;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:10px">${esc(name)}</div>
      <div style="font-family:var(--font-mono);font-size:42px;font-weight:700;line-height:1;color:${winning ? '#006BD6' : '#191919'};margin-bottom:12px">${score}</div>
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="tap" data-action="bump" data-which="${which}" data-d="-1" style="width:38px;height:38px;border-radius:999px;border:1px solid rgba(25,25,25,.15);background:#F5F5F5;display:flex;align-items:center;justify-content:center;color:#191919"><i class="ph-bold ph-minus" style="font-size:15px"></i></button>
        <button class="tap" data-action="bump" data-which="${which}" data-d="1" style="width:38px;height:38px;border-radius:999px;border:none;background:#006BD6;display:flex;align-items:center;justify-content:center;color:#fff"><i class="ph-bold ph-plus" style="font-size:15px"></i></button>
      </div>
    </div>`;

  const bothPicked = state.logA && state.logB && state.logA !== state.logB;
  const valid = bothPicked && validScore(state.scoreA, state.scoreB);
  let preview = '';
  if (bothPicked && valid) {
    const aWon = state.scoreA > state.scoreB;
    const A = P(state.logA), B = P(state.logB);
    const W = aWon ? A : B, L = aWon ? B : A;
    const ws = aWon ? state.scoreA : state.scoreB, ls = aWon ? state.scoreB : state.scoreA;
    const d = calcDelta(W.elo, L.elo, ws, ls, games(W));
    const upset = (L.elo - W.elo) >= 150;
    preview = `
    <div style="margin-top:18px;background:#F0F7FF;border:1px solid rgba(0,107,214,.25);border-radius:16px;padding:16px;animation:popIn .2s var(--ease)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px"><i class="ph-fill ph-trophy" style="color:#006BD6;font-size:18px"></i><span style="font-size:13px;font-weight:700;color:#191919">${esc(first(W.name))} wins ${ws}&ndash;${ls}</span></div>
      <div style="display:flex;gap:10px">
        <div style="flex:1;display:flex;align-items:center;justify-content:space-between;background:#fff;border-radius:12px;padding:10px 14px">
          <span style="font-size:14px;font-weight:700;color:#191919">${esc(first(A.name))}</span>
          <span style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:${aWon ? '#008928' : '#D1334A'}">${aWon ? '+' : '−'}${d}</span>
        </div>
        <div style="flex:1;display:flex;align-items:center;justify-content:space-between;background:#fff;border-radius:12px;padding:10px 14px">
          <span style="font-size:14px;font-weight:700;color:#191919">${esc(first(B.name))}</span>
          <span style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:${aWon ? '#D1334A' : '#008928'}">${aWon ? '−' : '+'}${d}</span>
        </div>
      </div>
      ${upset ? '<div style="margin-top:10px;display:flex;align-items:center;gap:6px;color:#DA2381;font-size:12px;font-weight:700"><i class="ph-fill ph-lightning"></i><span>Upset! Big rating swing.</span></div>' : ''}
    </div>`;
  } else if (bothPicked) {
    preview = `
    <div style="margin-top:18px;background:#FFF9E9;border:1px solid rgba(250,176,5,.4);border-radius:16px;padding:16px;animation:popIn .2s var(--ease)">
      <div style="display:flex;align-items:center;gap:8px;color:#946A00;font-size:13px;font-weight:500"><i class="ph-fill ph-warning-circle" style="font-size:18px"></i><span>A game goes to 11, win by 2 (e.g. 11&ndash;8 or 13&ndash;11).</span></div>
    </div>`;
  }

  return `
  <div style="padding:20px 16px 28px">
    ${header}
    <div style="display:flex;flex-direction:column;gap:12px">${youSection}${opponentSection}</div>
    <div style="font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:rgba(25,25,25,.5);margin:20px 0 8px 2px">Score</div>
    <div style="display:flex;gap:12px">
      ${scoreCard('a', scName(state.logA, 'Player 1'), state.scoreA, state.scoreA >= state.scoreB)}
      ${scoreCard('b', scName(state.logB, 'Player 2'), state.scoreB, state.scoreB > state.scoreA)}
    </div>
    ${preview}
    <button class="tap" data-action="submit-match" ${valid && !state.busy ? '' : 'disabled'} style="margin-top:18px;width:100%;height:54px;border:none;border-radius:999px;background:${valid && !state.busy ? '#006BD6' : 'rgba(25,25,25,.2)'};color:#fff;font-size:16px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px"><i class="ph-bold ph-check-circle" style="font-size:20px"></i>${state.busy ? 'Recording…' : 'Record match'}</button>
  </div>`;
}

// ---------- ratings-changed notes ----------
function ratingNotes() {
  const events = (state.ratingEvents || []).filter(e => !seenEvents.has(e.id));
  if (!events.length) return '';
  const cards = events.map(e => {
    let text;
    if (e.kind === 'penalty') {
      text = 'A penalty was applied to your rating after an admin review.';
    } else {
      const m = state.feed.find(x => x.id === e.match_id);
      const opp = m ? first((m.winnerId === state.identity ? m.loser : m.winner).name) : 'an opponent';
      text = `Your match vs ${esc(opp)} was voided by the admin — its ELO was reversed.`;
    }
    return `
    <div style="background:#fff;border:1px solid rgba(25,25,25,.12);border-left:3px solid #D1334A;border-radius:12px;padding:11px 13px;display:flex;align-items:center;gap:10px">
      <i class="ph-fill ph-arrows-counter-clockwise" style="color:#D1334A;font-size:18px;flex-shrink:0"></i>
      <span style="flex:1;font-size:12.5px;line-height:17px;color:#191919;font-weight:400">${text} <span style="font-family:var(--font-mono);color:rgba(25,25,25,.55)">now ${e.rating_after}</span></span>
      <button class="tap" data-action="dismiss-event" data-id="${esc(e.id)}" style="border:none;background:transparent;color:rgba(25,25,25,.4);width:26px;height:26px;border-radius:999px;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="ph-bold ph-x" style="font-size:14px"></i></button>
    </div>`;
  }).join('');
  return `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${cards}</div>`;
}

// ---------- feed ----------
function viewFeed() {
  const head = `
    <h1 style="font-size:28px;font-weight:700;color:#191919;margin:0 0 2px;letter-spacing:-.5px">Match feed</h1>
    <p style="margin:0 0 18px;font-size:13px;color:rgba(25,25,25,.55);font-weight:300">Every game, live. React and talk trash.</p>`;

  if (!state.feed.length) {
    return `
    <div style="padding:20px 16px 28px">
      ${head}
      <div style="text-align:center;padding:40px 22px;background:#fff;border:1px solid var(--hairline);border-radius:16px">
        <div style="width:56px;height:56px;border-radius:16px;background:#F5F5F5;display:flex;align-items:center;justify-content:center;margin:0 auto 14px"><i class="ph ph-ping-pong" style="color:rgba(25,25,25,.35);font-size:30px"></i></div>
        <div style="font-size:16px;font-weight:700;color:#191919">No matches yet</div>
        <div style="font-size:13px;color:rgba(25,25,25,.55);font-weight:300;margin-top:4px">Play a game, then log it &mdash; it'll show up here for everyone to react to.</div>
      </div>
    </div>`;
  }

  const cards = state.feed.map(m => {
    const open = state.openComments.has(m.id);
    const disputed = m.status === 'disputed' && !m.isVoided;
    const voided = m.isVoided;
    const rBtn = (kind, glyph, n) => `
      <button class="tap" data-action="react" data-id="${esc(m.id)}" data-kind="${kind}" style="border:1px solid ${n > 0 ? 'rgba(0,107,214,.3)' : 'rgba(25,25,25,.12)'};background:${n > 0 ? 'rgba(0,107,214,.08)' : '#fff'};border-radius:999px;height:30px;padding:0 10px;display:flex;align-items:center;gap:5px;font-size:13px;font-weight:700;color:#191919"><span>${glyph}</span>${n}</button>`;
    const W = m.winner, L = m.loser;
    const wc = api.textColorFor(W.avatar_color), lc = api.textColorFor(L.avatar_color);
    const comments = m.comments.map(c => `
      <div style="display:flex;gap:8px;align-items:flex-start">
        <div style="width:24px;height:24px;border-radius:999px;background:${c.author ? c.author.avatar_color : '#999'};color:${c.author ? api.textColorFor(c.author.avatar_color) : '#fff'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:9px;flex-shrink:0;margin-top:1px">${c.author ? esc(c.author.initials) : '?'}</div>
        <div style="background:#F5F5F5;border-radius:12px;padding:7px 11px"><span style="font-size:12px;font-weight:700;color:#191919">${c.author ? esc(first(c.author.name)) : '?'}</span> <span style="font-size:12px;color:#191919;font-weight:300">${esc(c.text)}</span></div>
      </div>`).join('');
    return `
    <div style="background:#fff;border:1px solid var(--hairline);border-radius:16px;overflow:hidden;box-shadow:0 6px 18px -14px rgba(25,25,25,.4)">
      ${m.upset && !disputed && !voided ? '<div style="background:#DA2381;color:#fff;font-size:11px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;padding:5px 16px;display:flex;align-items:center;gap:6px"><i class="ph-fill ph-lightning"></i>Upset of the day</div>' : ''}
      ${disputed ? '<div style="background:#FFF7E0;color:#946A00;font-size:11px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;padding:6px 16px;display:flex;align-items:center;gap:6px;border-bottom:1px solid #F2C94C"><i class="ph-fill ph-warning"></i>Disputed &middot; with the admin</div>' : ''}
      ${voided ? '<div style="background:#F0F0F0;color:rgba(25,25,25,.55);font-size:11px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;padding:6px 16px;display:flex;align-items:center;gap:6px;border-bottom:1px solid rgba(25,25,25,.12)"><i class="ph-fill ph-prohibit"></i>Voided by admin &middot; no ELO</div>' : ''}
      <div style="padding:14px 16px 12px;opacity:${voided ? '.5' : '1'}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:10px;flex:1">
            <div style="width:40px;height:40px;border-radius:999px;background:${W.avatar_color};color:${wc};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;position:relative">${esc(W.initials)}<i class="ph-fill ph-crown-simple" style="position:absolute;top:-9px;right:-6px;color:#FAB005;font-size:15px;transform:rotate(18deg)"></i></div>
            <div><div style="font-size:14px;font-weight:700;color:#191919;line-height:1.1">${esc(first(W.name))}</div><div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:#008928">+${m.delta}</div></div>
          </div>
          <div style="text-align:center;padding:0 6px"><div style="font-family:var(--font-mono);font-size:22px;font-weight:700;color:#191919;line-height:1">${m.winnerScore}&ndash;${m.loserScore}</div><div style="font-size:10px;color:rgba(25,25,25,.4);font-weight:700;letter-spacing:.5px">${fmtTime(m.playedAt)}</div></div>
          <div style="display:flex;align-items:center;gap:10px;flex:1;justify-content:flex-end;text-align:right">
            <div><div style="font-size:14px;font-weight:700;color:#191919;line-height:1.1">${esc(first(L.name))}</div><div style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:#D1334A">&minus;${m.delta}</div></div>
            <div style="width:40px;height:40px;border-radius:999px;background:${L.avatar_color};color:${lc};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px">${esc(L.initials)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;border-top:1px solid rgba(25,25,25,.07);padding-top:10px">
          ${rBtn('fire', '🔥', m.reactions.fire)}${rBtn('wow', '😮', m.reactions.wow)}${rBtn('gg', '🤝', m.reactions.gg)}
          <button class="tap" data-action="toggle-comments" data-id="${esc(m.id)}" style="margin-left:auto;border:none;background:transparent;display:flex;align-items:center;gap:5px;color:rgba(25,25,25,.55);font-size:13px;font-weight:700"><i class="ph-bold ph-chat-circle" style="font-size:16px"></i>${m.comments.length}</button>
          <button class="tap" data-action="open-dispute" data-id="${esc(m.id)}" title="Match options" style="border:none;background:transparent;width:30px;height:30px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:rgba(25,25,25,.4)"><i class="ph-bold ph-dots-three-outline" style="font-size:16px"></i></button>
        </div>
        ${open ? `
        <div style="margin-top:10px;border-top:1px solid rgba(25,25,25,.07);padding-top:10px;display:flex;flex-direction:column;gap:8px">
          ${comments}
          ${canAct() ? `
          <div style="display:flex;gap:8px;align-items:center;margin-top:2px">
            <input id="draft-${esc(m.id)}" data-draft="${esc(m.id)}" placeholder="Add some trash talk…" style="flex:1;height:38px;border:1px solid rgba(25,25,25,.15);border-radius:999px;padding:0 14px;font-size:13px;color:#191919;outline:none" />
            <button class="tap" data-action="send-comment" data-id="${esc(m.id)}" style="width:38px;height:38px;border-radius:999px;border:none;background:#006BD6;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="ph-bold ph-paper-plane-right" style="font-size:16px"></i></button>
          </div>` : `
          <div style="display:flex;align-items:center;gap:7px;margin-top:2px;background:#F5F5F5;border-radius:10px;padding:9px 12px;color:rgba(25,25,25,.5);font-size:12px;font-weight:500"><i class="ph-fill ph-hourglass-medium" style="font-size:14px"></i><span>Verify your sign-in to join the chat.</span></div>`}
        </div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `
  <div style="padding:20px 16px 28px">
    ${head}
    ${ratingNotes()}
    <div style="display:flex;flex-direction:column;gap:14px">${cards}</div>
  </div>`;
}

// ---------- profile ----------
function viewProfile() {
  const pp = P(state.profileId || state.identity);
  if (!pp) return `<div style="padding:40px;text-align:center;color:rgba(25,25,25,.45)">Sign in to see your profile.</div>`;
  const d = state.profileData;
  if (!d) return `<div style="padding:60px 20px;text-align:center;color:rgba(25,25,25,.45);font-size:14px;font-weight:300">Loading…</div>`;

  const series = [1000, ...d.history.map(h => h.rating_after)];
  if (series.length === 1) series.push(pp.elo);
  const mn = Math.min(...series), mx = Math.max(...series), rng = Math.max(1, mx - mn);
  const spark = series.map((v, i) => {
    const x = (i / (series.length - 1)) * 300;
    const y = 58 - ((v - mn) / rng) * 52;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');

  const recent = d.matches.slice(0, 5).map(m => {
    const won = m.winner_id === pp.id;
    const opp = won ? m.loser : m.winner;
    return `
    <div style="display:flex;align-items:center;gap:12px;background:#fff;border:1px solid var(--hairline);border-radius:12px;padding:10px 14px">
      <div style="width:26px;height:26px;border-radius:8px;background:${won ? '#DCF5E3' : '#FCE4E8'};color:${won ? '#008928' : '#D1334A'};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;flex-shrink:0">${won ? 'W' : 'L'}</div>
      <span style="flex:1;font-size:14px;color:#191919;font-weight:400">vs <strong style="font-weight:700">${esc(first(opp.name))}</strong></span>
      <span style="font-family:var(--font-mono);font-size:13px;color:rgba(25,25,25,.6)">${m.winner_score}&ndash;${m.loser_score}</span>
      <span style="font-family:var(--font-mono);font-size:13px;font-weight:700;color:${won ? '#008928' : '#D1334A'};width:38px;text-align:right">${won ? '+' : '−'}${m.elo_delta}</span>
    </div>`;
  }).join('') || `<div style="padding:16px;background:#fff;border:1px solid var(--hairline);border-radius:12px;font-size:13px;color:rgba(25,25,25,.5);font-weight:300;text-align:center">No matches yet this season.</div>`;

  // Head-to-head: every opponent this player has actually played, most-played first.
  const oppIds = new Set();
  d.matches.forEach(m => {
    if (m.winner_id === pp.id) oppIds.add(m.loser_id);
    else if (m.loser_id === pp.id) oppIds.add(m.winner_id);
  });
  const oldestFirst = [...d.matches].reverse();
  const statOf = oid => {
    let w = 0, l = 0; const form = [];
    oldestFirst.forEach(m => {
      if (m.winner_id === pp.id && m.loser_id === oid) { w++; form.push('W'); }
      else if (m.loser_id === pp.id && m.winner_id === oid) { l++; form.push('L'); }
    });
    return { w, l, total: w + l, form: form.slice(-4) };
  };
  const rivalStats = [...oppIds]
    .filter(oid => P(oid))
    .map(oid => ({ id: oid, p: P(oid), ...statOf(oid) }))
    .sort((a, b) => b.total - a.total || b.p.elo - a.p.elo);

  // selected rivalry: pinned pick if still valid, else the most-played opponent
  const selId = (state.rivalId && state.rivalId !== pp.id && oppIds.has(state.rivalId))
    ? state.rivalId : (rivalStats[0] ? rivalStats[0].id : null);
  const sel = selId ? rivalStats.find(r => r.id === selId) : null;
  const myPct = sel && sel.total ? Math.round(sel.w / sel.total * 100) : 50;
  const theirPct = 100 - myPct;

  let verdict = '', vColor = '';
  if (sel) {
    if (sel.w > sel.l) { verdict = `${first(pp.name)} leads ${sel.w}–${sel.l}`; vColor = '#008928'; }
    else if (sel.l > sel.w) { verdict = `${first(sel.p.name)} leads ${sel.l}–${sel.w}`; vColor = '#D1334A'; }
    else { verdict = `All square, ${sel.w}–${sel.l}`; vColor = 'rgba(25,25,25,.6)'; }
  }

  const featured = sel ? `
    <div style="background:#fff;border:1px solid rgba(25,25,25,.08);border-radius:16px;padding:18px 16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;min-width:0">
          <div style="width:46px;height:46px;border-radius:999px;background:${pp.color};color:${pp.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;flex-shrink:0">${esc(pp.initials)}</div>
          <div style="font-size:13px;font-weight:700;color:#191919;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(first(pp.name))}</div>
        </div>
        <div style="display:flex;align-items:baseline;gap:7px;padding:0 4px;flex-shrink:0">
          <span style="font-family:var(--font-mono);font-size:38px;font-weight:700;color:#006BD6;line-height:1">${sel.w}</span>
          <span style="font-size:14px;font-weight:900;color:rgba(25,25,25,.3)">&ndash;</span>
          <span style="font-family:var(--font-mono);font-size:38px;font-weight:700;color:#D1334A;line-height:1">${sel.l}</span>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;min-width:0">
          <div style="width:46px;height:46px;border-radius:999px;background:${sel.p.color};color:${sel.p.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;flex-shrink:0">${esc(sel.p.initials)}</div>
          <div style="font-size:13px;font-weight:700;color:#191919;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(first(sel.p.name))}</div>
        </div>
      </div>
      <div style="display:flex;height:10px;border-radius:999px;overflow:hidden;background:#F0F0F0">
        <div style="width:${myPct}%;background:#006BD6"></div>
        <div style="flex:1;background:#D1334A"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;font-weight:700"><span style="color:#006BD6">${myPct}% you</span><span style="color:#D1334A">${theirPct}% them</span></div>
      ${sel.form.length ? `
      <div style="display:flex;align-items:center;gap:8px;margin-top:14px">
        <span style="font-size:10.5px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;color:rgba(25,25,25,.4)">Last ${sel.form.length}</span>
        <div style="display:flex;gap:4px">${sel.form.map(f => `<span style="width:20px;height:20px;border-radius:6px;background:${f === 'W' ? '#008928' : '#D1334A'};color:#fff;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center">${f}</span>`).join('')}</div>
        <span style="margin-left:auto;font-family:var(--font-mono);font-size:12px;color:rgba(25,25,25,.45)">ELO ${sel.p.elo}</span>
      </div>` : ''}
      <div style="text-align:center;margin-top:14px;font-size:13px;font-weight:500;color:${vColor}">${esc(verdict)}</div>
    </div>` : '';

  const rivalCount = rivalStats.length + (rivalStats.length === 1 ? ' rival' : ' rivals');
  const rivalRows = rivalStats.map(r => {
    const rMyPct = r.total ? Math.round(r.w / r.total * 100) : 0;
    const isSel = r.id === selId;
    return `
    <button class="tap row" data-action="set-rival" data-id="${esc(r.id)}" style="width:100%;display:flex;align-items:center;gap:12px;background:${isSel ? '#EAF4FF' : '#fff'};border:1px solid ${isSel ? 'rgba(0,107,214,.4)' : 'rgba(25,25,25,.08)'};border-radius:14px;padding:10px 12px;text-align:left">
      <div style="width:36px;height:36px;border-radius:999px;background:${r.p.color};color:${r.p.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0">${esc(r.p.initials)}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px"><span style="font-size:14px;font-weight:700;color:#191919;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(first(r.p.name))}</span><span style="display:flex;align-items:center;gap:8px;flex-shrink:0"><span style="font-size:11px;font-weight:400;color:rgba(25,25,25,.45)">${r.total} game${r.total === 1 ? '' : 's'}</span><span style="font-family:var(--font-mono);font-size:12.5px;font-weight:700;color:#191919">${r.w}&ndash;${r.l}</span></span></div>
        <div style="display:flex;height:6px;border-radius:999px;overflow:hidden;background:#EDEDED"><div style="width:${rMyPct}%;background:#006BD6"></div><div style="flex:1;background:#E4A0AC"></div></div>
      </div>
    </button>`;
  }).join('');

  const h2hHeader = `<div style="font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:rgba(25,25,25,.5);margin:22px 0 8px 2px">Head-to-head</div>`;
  const h2hSection = sel ? `
    ${h2hHeader}
    ${featured}
    <div style="display:flex;align-items:center;justify-content:space-between;margin:20px 2px 8px">
      <span style="font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:rgba(25,25,25,.5)">Everyone you&rsquo;ve played</span>
      <span style="font-size:11px;font-weight:700;color:rgba(25,25,25,.4)">${rivalCount}</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">${rivalRows}</div>` : `
    ${h2hHeader}
    <div style="background:#fff;border:1px solid rgba(25,25,25,.08);border-radius:16px;padding:26px 20px;text-align:center">
      <div style="width:48px;height:48px;border-radius:13px;background:#F5F5F5;display:flex;align-items:center;justify-content:center;margin:0 auto 11px"><i class="ph ph-sword" style="font-size:24px;color:rgba(25,25,25,.35)"></i></div>
      <div style="font-size:14px;font-weight:700;color:#191919">No rivalries yet</div>
      <div style="font-size:12.5px;font-weight:300;color:rgba(25,25,25,.55);margin-top:3px">Log a match to start building a head-to-head record.</div>
    </div>`;

  return `
  <div style="padding:16px 16px 28px">
    <button class="tap" data-action="nav" data-screen="leaderboard" style="border:none;background:transparent;display:flex;align-items:center;gap:6px;color:rgba(25,25,25,.6);font-size:14px;font-weight:700;padding:4px 0;margin-bottom:8px"><i class="ph-bold ph-arrow-left" style="font-size:17px"></i>Leaderboard</button>
    <div style="background:#fff;border:1px solid var(--hairline);border-radius:20px;padding:20px;text-align:center;box-shadow:0 8px 24px -16px rgba(25,25,25,.4)">
      <div style="width:76px;height:76px;border-radius:999px;background:${pp.color};color:${pp.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:28px;margin:0 auto 10px">${esc(pp.initials)}</div>
      <div style="font-size:22px;font-weight:700;color:#191919;line-height:1.1">${esc(pp.name)}</div>
      <div style="font-size:13px;color:rgba(25,25,25,.5);font-weight:400;margin-top:2px">Rank #${rankOf(pp.id)} &middot; ${pp.wins > pp.losses ? 'On the rise' : 'Fighting back'}</div>
      <div style="display:flex;justify-content:center;gap:0;margin-top:16px">
        <div style="flex:1;border-right:1px solid rgba(25,25,25,.1)"><div style="font-family:var(--font-mono);font-size:22px;font-weight:700;color:#006BD6">${pp.elo}</div><div style="font-size:11px;color:rgba(25,25,25,.5);font-weight:700;text-transform:uppercase;letter-spacing:.5px">ELO</div></div>
        <div style="flex:1;border-right:1px solid rgba(25,25,25,.1)"><div style="font-family:var(--font-mono);font-size:22px;font-weight:700;color:#191919">${pp.wins}&ndash;${pp.losses}</div><div style="font-size:11px;color:rgba(25,25,25,.5);font-weight:700;text-transform:uppercase;letter-spacing:.5px">W&ndash;L</div></div>
        <div style="flex:1"><div style="font-family:var(--font-mono);font-size:22px;font-weight:700;color:#191919">${pp.peak}</div><div style="font-size:11px;color:rgba(25,25,25,.5);font-weight:700;text-transform:uppercase;letter-spacing:.5px">Peak</div></div>
      </div>
      <div style="margin-top:16px"><svg viewBox="0 0 300 64" preserveAspectRatio="none" style="width:100%;height:52px"><polyline points="${spark}" fill="none" stroke="#006BD6" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></polyline></svg></div>
    </div>

    ${h2hSection}

    <div style="font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:rgba(25,25,25,.5);margin:22px 0 8px 2px">Recent matches</div>
    <div style="display:flex;flex-direction:column;gap:8px">${recent}</div>
  </div>`;
}

// ---------- admin ----------
const REASON_LABELS = { score: 'Wrong score', nothappen: 'Match never happened', wrongplayer: 'Wrong player', other: 'Other' };

function viewAdmin() {
  if (!isAdmin()) { state.screen = 'leaderboard'; return viewLeaderboard(); }
  const disputes = state.feed.filter(m => m.status === 'disputed' && !m.isVoided);
  const disputeCards = disputes.map(m => {
    const W = m.winner, L = m.loser;
    const by = m.disputedBy ? P(m.disputedBy) : null;
    return `
    <div style="background:#fff;border:1px solid #F2C94C;border-radius:16px;overflow:hidden">
      <div style="background:#FFF7E0;padding:6px 14px;display:flex;align-items:center;justify-content:space-between"><span style="font-size:11px;font-weight:900;letter-spacing:.5px;text-transform:uppercase;color:#946A00">Reason: ${esc(REASON_LABELS[m.disputeReason] || 'Flagged')}</span><span style="font-size:11px;font-weight:700;color:#946A00">by ${esc(by ? first(by.name) : '—')}</span></div>
      <div style="padding:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:8px;flex:1"><div style="width:34px;height:34px;border-radius:999px;background:${W.avatar_color};color:${api.textColorFor(W.avatar_color)};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px">${esc(W.initials)}</div><span style="font-size:14px;font-weight:700;color:#191919">${esc(first(W.name))}</span></div>
          <div style="text-align:center;padding:0 8px"><div style="font-family:var(--font-mono);font-size:20px;font-weight:700;color:#191919;line-height:1">${m.winnerScore}&ndash;${m.loserScore}</div><div style="font-size:10px;color:rgba(25,25,25,.4);font-weight:700">${fmtTime(m.playedAt)}</div></div>
          <div style="display:flex;align-items:center;gap:8px;flex:1;justify-content:flex-end;text-align:right"><span style="font-size:14px;font-weight:700;color:#191919">${esc(first(L.name))}</span><div style="width:34px;height:34px;border-radius:999px;background:${L.avatar_color};color:${api.textColorFor(L.avatar_color)};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px">${esc(L.initials)}</div></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="tap" data-action="resolve" data-id="${esc(m.id)}" data-act="uphold" ${state.busy ? 'disabled' : ''} style="flex:1;height:42px;border:1.5px solid rgba(25,25,25,.15);background:#fff;border-radius:999px;color:#191919;font-size:13px;font-weight:700">Uphold</button>
          <button class="tap" data-action="resolve" data-id="${esc(m.id)}" data-act="void" ${state.busy ? 'disabled' : ''} style="flex:1;height:42px;border:1.5px solid rgba(25,25,25,.15);background:#fff;border-radius:999px;color:#191919;font-size:13px;font-weight:700">Void</button>
        </div>
        <button class="tap" data-action="resolve" data-id="${esc(m.id)}" data-act="void_penalize" ${state.busy ? 'disabled' : ''} style="width:100%;height:42px;margin-top:8px;border:none;background:#D1334A;border-radius:999px;color:#fff;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:6px"><i class="ph-bold ph-gavel" style="font-size:16px"></i>Void &amp; penalise &minus;50</button>
      </div>
    </div>`;
  }).join('');

  const claimCards = state.claims.map(c => {
    const p = P(c.player_id);
    return `
    <div style="background:#fff;border:1px solid var(--hairline);border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:12px">
      <div style="width:40px;height:40px;border-radius:999px;background:${p ? p.color : '#999'};color:${p ? p.textColor : '#fff'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0">${p ? esc(p.initials) : '?'}</div>
      <div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:700;color:#191919">${esc(p ? p.name : c.player_id)}</div><div style="font-size:11px;color:rgba(25,25,25,.5);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.email)}</div></div>
      <button class="tap" data-action="reject-claim" data-id="${esc(c.id)}" ${state.busy ? 'disabled' : ''} title="Reject" style="width:38px;height:38px;border-radius:999px;border:1.5px solid rgba(25,25,25,.15);background:#fff;color:#D1334A;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="ph-bold ph-x" style="font-size:16px"></i></button>
      <button class="tap" data-action="approve-claim" data-id="${esc(c.id)}" ${state.busy ? 'disabled' : ''} title="Approve" style="width:38px;height:38px;border-radius:999px;border:none;background:#008928;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="ph-bold ph-check" style="font-size:16px"></i></button>
    </div>`;
  }).join('');

  return `
  <div style="padding:20px 16px 28px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px"><i class="ph-fill ph-shield-check" style="color:#006BD6;font-size:24px"></i><h1 style="font-size:28px;font-weight:700;color:#191919;margin:0;letter-spacing:-.5px">Admin</h1></div>
    <p style="margin:0 0 20px;font-size:13px;color:rgba(25,25,25,.55);font-weight:300">Only you see this tab. Disputes and sign-in claims land here.</p>

    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="font-size:12px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:#191919">Disputes</span><span style="font-size:11px;font-weight:900;background:#FDECEF;color:#D1334A;border-radius:999px;padding:1px 8px">${disputes.length}</span></div>
    ${disputes.length ? `<div style="display:flex;flex-direction:column;gap:12px;margin-bottom:24px">${disputeCards}</div>`
      : `<div style="background:#fff;border:1px solid var(--hairline);border-radius:14px;padding:22px;text-align:center;color:rgba(25,25,25,.5);font-size:13px;font-weight:300;margin-bottom:24px"><i class="ph ph-check-circle" style="font-size:22px;color:#008928;display:block;margin-bottom:6px"></i>No open disputes. The ladder's clean.</div>`}

    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="font-size:12px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:#191919">Claims to approve</span><span style="font-size:11px;font-weight:900;background:#E5F3FF;color:#006BD6;border-radius:999px;padding:1px 8px">${state.claims.length}</span></div>
    ${state.claims.length ? `<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:24px">${claimCards}</div>`
      : `<div style="background:#fff;border:1px solid var(--hairline);border-radius:14px;padding:22px;text-align:center;color:rgba(25,25,25,.5);font-size:13px;font-weight:300;margin-bottom:24px">No one waiting to be verified.</div>`}

    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="font-size:12px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:#191919">Rollout</span></div>
    <button class="tap" data-action="toggle-rollout" ${state.busy ? 'disabled' : ''} style="width:100%;background:#fff;border:1px solid var(--hairline);border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:12px;text-align:left">
      <span style="width:40px;height:24px;border-radius:999px;background:${state.rolloutComplete ? '#008928' : 'rgba(25,25,25,.2)'};position:relative;flex-shrink:0;transition:background .15s"><span style="position:absolute;top:2px;left:${state.rolloutComplete ? '18px' : '2px'};width:20px;height:20px;border-radius:999px;background:#fff;transition:left .15s"></span></span>
      <span style="flex:1"><span style="display:block;font-size:14px;font-weight:700;color:#191919">Rollout complete</span><span style="display:block;font-size:12px;color:rgba(25,25,25,.55);font-weight:300;line-height:16px">${state.rolloutComplete ? 'New sign-ins can only create a new player.' : 'New sign-ins can still claim an existing name.'}</span></span>
    </button>
  </div>`;
}

// ---------- identity gate / claim flow ----------
function renderGate() {
  const show = !state.loading && !state.error && !state.identity;
  if (!show) { $('gate').innerHTML = ''; return; }

  const step = state.authStep || 'email';
  const emailOk = emailValid(state.authEmail);

  // claim step: create-new only after rollout / when nothing's claimable
  const list = claimable();
  const gateCreating = state.creating || state.players.length === 0 || state.rolloutComplete || list.length === 0;
  const newName = ($('new-name') && $('new-name').value) || state._newName || '';
  const nm = newName.trim();
  const dupe = nm.length > 0 && state.players.some(p => p.name.toLowerCase() === nm.toLowerCase());
  const createDisabled = nm.length === 0 || dupe || state.busy;
  const PAL = [['#006BD6', '#fff'], ['#DA2381', '#fff'], ['#008928', '#fff'], ['#FAB005', '#191919'], ['#D1334A', '#fff'], ['#191919', '#fff'], ['#0369A1', '#fff'], ['#C2410C', '#fff']];
  const [ncBg, ncText] = PAL[state.players.length % PAL.length];

  const titles = {
    email: ['Sign in to EF Pong', 'One tap to sign in — no password. New here? You’ll pick your name next.'],
    sent: ['Check your email', 'Open the link we just sent to finish signing in on this device.'],
    claim: state.rolloutComplete
      ? ['Add yourself', 'Everyone’s onboarded, so new sign-ins create a new player. An admin approves you before you can log or dispute.']
      : ['Claim your name', 'New here? Pick the name you already play under, or add a new one. An admin confirms it’s you.'],
  };
  const gt = titles[step] || titles.email;
  const activeIdx = (step === 'email' || step === 'sent') ? 0 : 1;
  const progress = ['Verify email', 'Claim name'].map((name, i) => `
    <div style="flex:1;display:flex;flex-direction:column;gap:6px">
      <div style="height:4px;border-radius:999px;background:${i <= activeIdx ? '#006BD6' : 'rgba(0,107,214,.15)'}"></div>
      <span style="font-size:10px;font-weight:900;letter-spacing:.6px;text-transform:uppercase;color:${i <= activeIdx ? '#006BD6' : 'rgba(25,25,25,.35)'}">${name}</span>
    </div>`).join('');

  let body = '';
  if (step === 'email') {
    const oauthProviders = AUTH_PROVIDERS.filter(p => p !== 'email');
    const providerBtns = oauthProviders.map(p => {
      const m = PROVIDER_META[p] || { label: 'Continue with ' + p, icon: 'ph-sign-in', color: '#191919' };
      return `<button class="tap" data-action="oauth" data-provider="${p}" ${state.busy ? 'disabled' : ''} style="width:100%;height:52px;border:1.5px solid rgba(25,25,25,.15);background:#fff;border-radius:999px;display:flex;align-items:center;justify-content:center;gap:10px;color:#191919;font-size:15px;font-weight:700"><i class="ph-bold ${m.icon}" style="font-size:20px;color:${m.color}"></i>${m.label}</button>`;
    }).join('');
    const emailFallback = AUTH_PROVIDERS.includes('email') ? `
      <div style="display:flex;align-items:center;gap:10px;margin:6px 0"><div style="flex:1;height:1px;background:rgba(25,25,25,.12)"></div><span style="font-size:11px;font-weight:700;color:rgba(25,25,25,.4);text-transform:uppercase;letter-spacing:.5px">or use email</span><div style="flex:1;height:1px;background:rgba(25,25,25,.12)"></div></div>
      <div style="background:#fff;border:1.5px solid rgba(25,25,25,.12);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:10px">
        <input id="auth-email" value="${esc(state.authEmail)}" type="email" placeholder="you@example.com" autocomplete="email" style="width:100%;height:48px;border:1.5px solid rgba(25,25,25,.15);border-radius:12px;padding:0 14px;font-size:16px;font-weight:500;color:#191919;outline:none" />
        <button class="tap" data-action="send-link" ${emailOk && !state.busy ? '' : 'disabled'} style="width:100%;height:48px;border:none;border-radius:999px;background:${emailOk && !state.busy ? '#006BD6' : 'rgba(25,25,25,.2)'};color:#fff;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px"><i class="ph-bold ph-paper-plane-tilt" style="font-size:18px"></i>${state.busy ? 'Sending…' : 'Send magic link'}</button>
        <p style="margin:0;font-size:11px;color:rgba(25,25,25,.45);font-weight:300;text-align:center">Magic-link email can be slow to arrive — the buttons above are faster.</p>
      </div>` : '';
    body = providerBtns + emailFallback;
  } else if (step === 'sent') {
    body = `
    <div style="background:#fff;border:1.5px solid rgba(0,107,214,.25);border-radius:16px;padding:22px 16px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center">
      <div style="width:64px;height:64px;border-radius:16px;background:#E5F3FF;display:flex;align-items:center;justify-content:center"><i class="ph-fill ph-envelope-simple-open" style="color:#006BD6;font-size:32px"></i></div>
      <div style="font-size:15px;font-weight:500;color:#191919;line-height:22px">We sent a magic link to<br><b style="font-weight:700">${esc(state.authEmail)}</b></div>
      <p style="margin:0;font-size:12.5px;color:rgba(25,25,25,.55);font-weight:300;line-height:18px">Open it on this device to finish signing in — you'll land back here automatically.</p>
      <button class="tap" data-action="change-email" style="border:none;background:transparent;color:rgba(25,25,25,.55);font-size:13px;font-weight:700;padding:2px 0">Use a different email</button>
    </div>`;
  } else if (gateCreating) {
    body = `
      ${state.players.length === 0 ? `
      <div style="text-align:center;padding:14px 8px 4px">
        <div style="width:52px;height:52px;border-radius:14px;background:#E5F3FF;display:flex;align-items:center;justify-content:center;margin:0 auto 12px"><i class="ph-fill ph-confetti" style="color:#006BD6;font-size:26px"></i></div>
        <div style="font-size:16px;font-weight:700;color:#191919">No players yet</div>
        <div style="font-size:13px;color:rgba(25,25,25,.55);font-weight:300;margin-top:2px">Be the first — add yourself to start the ladder.</div>
      </div>` : ''}
      <div style="background:#fff;border:1.5px solid rgba(0,107,214,.25);border-radius:16px;padding:18px 16px;display:flex;flex-direction:column;align-items:center;gap:14px">
        <div id="nc-avatar" style="width:64px;height:64px;border-radius:999px;background:${ncBg};color:${ncText};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px">${nm ? esc(mkInitials(nm)) : '?'}</div>
        <input id="new-name" value="${esc(newName)}" placeholder="Type your full name" autocomplete="off" style="width:100%;height:46px;border:1.5px solid rgba(25,25,25,.15);border-radius:12px;padding:0 14px;font-size:16px;font-weight:500;color:#191919;outline:none;text-align:center" />
        <div id="dupe-warn" class="${dupe ? '' : 'hidden'}" style="display:flex;align-items:center;gap:6px;color:#946A00;font-size:12px;font-weight:500;text-align:center"><i class="ph-fill ph-warning-circle" style="font-size:15px;flex-shrink:0"></i><span>Someone already has that name — add a last initial to tell you apart.</span></div>
        <button id="create-btn" class="tap" data-action="create-player" ${createDisabled ? 'disabled' : ''} style="width:100%;height:48px;border:none;border-radius:999px;background:${createDisabled ? 'rgba(25,25,25,.2)' : '#006BD6'};color:#fff;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px"><i class="ph-bold ph-user-plus" style="font-size:18px"></i>Add me &amp; continue</button>
        <p style="margin:0;font-size:11px;color:rgba(25,25,25,.45);font-weight:300;text-align:center">You'll start at 1000 ELO, like everyone else.</p>
      </div>
      ${state.creating && list.length > 0 && !state.rolloutComplete ? '<button class="tap" data-action="cancel-create" style="border:none;background:transparent;color:rgba(25,25,25,.55);font-size:13px;font-weight:700;padding:6px 0">Back to the list</button>' : ''}`;
  } else {
    const options = list.map(p => `
      <button class="tap" data-action="claim-identity" data-id="${esc(p.id)}" style="display:flex;align-items:center;gap:12px;background:#fff;border:1.5px solid var(--hairline);border-radius:14px;padding:11px 14px;text-align:left;width:100%">
        ${avatar(p, 40, 14)}
        <span style="flex:1;font-size:16px;font-weight:700;color:#191919">${esc(p.name)}</span>
        <span style="font-family:var(--font-mono);font-size:13px;color:rgba(25,25,25,.45)">${p.elo}</span>
      </button>`).join('');
    body = `
      <button class="tap" data-action="open-create" style="display:flex;align-items:center;justify-content:center;gap:8px;background:#E5F3FF;border:1.5px dashed rgba(0,107,214,.4);border-radius:14px;padding:12px 14px;width:100%;color:#006BD6;font-size:14px;font-weight:700"><i class="ph-bold ph-user-plus" style="font-size:18px"></i>I'm new — add me</button>
      ${options}`;
  }

  $('gate').innerHTML = `
  <div style="position:fixed;inset:0;z-index:70;background:#fff;display:flex;flex-direction:column;max-width:480px;margin:0 auto">
    <div style="padding:${step === 'email' || step === 'sent' ? '40px' : '28px'} 26px 16px;flex-shrink:0">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
        <div style="width:34px;height:34px;border-radius:9px;background:#006BD6;display:flex;align-items:center;justify-content:center"><i class="ph-fill ph-ping-pong" style="color:#fff;font-size:21px"></i></div>
        <span style="font-size:22px;font-weight:900;letter-spacing:-.5px;color:#191919">EF Pong</span>
        ${state.session ? '<button class="tap" data-action="sign-out" style="margin-left:auto;border:none;background:#F5F5F5;height:34px;padding:0 12px;border-radius:999px;display:flex;align-items:center;gap:6px;color:#191919;font-size:12px;font-weight:700"><i class="ph-bold ph-sign-out" style="font-size:14px"></i>Sign out</button>' : ''}
      </div>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">${progress}</div>
      <h1 style="font-size:26px;font-weight:700;color:#191919;margin:0 0 6px;letter-spacing:-.5px">${esc(gt[0])}</h1>
      <p style="margin:0;font-size:14px;line-height:20px;color:rgba(25,25,25,.6);font-weight:300">${esc(gt[1])}</p>
    </div>
    <div class="app-scroll" style="flex:1;overflow-y:auto;padding:4px 18px 24px;display:flex;flex-direction:column;gap:8px">${body}</div>
  </div>`;

  // wire live inputs without re-render (keep focus)
  const emailInput = $('auth-email');
  if (emailInput) {
    emailInput.addEventListener('input', () => {
      state.authEmail = emailInput.value;
      const btn = emailInput.parentElement.querySelector('[data-action="send-link"]');
      const ok = emailValid(emailInput.value);
      btn.disabled = !ok || state.busy;
      btn.style.background = (ok && !state.busy) ? '#006BD6' : 'rgba(25,25,25,.2)';
    });
    emailInput.addEventListener('keydown', e => { if (e.key === 'Enter' && emailValid(emailInput.value)) actions['send-link'](); });
    emailInput.focus();
  }
  const nameInput = $('new-name');
  if (nameInput) {
    nameInput.addEventListener('input', () => {
      state._newName = nameInput.value;
      const v = nameInput.value.trim();
      $('nc-avatar').textContent = v ? mkInitials(v) : '?';
      const isDupe = v.length > 0 && state.players.some(p => p.name.toLowerCase() === v.toLowerCase());
      $('dupe-warn').classList.toggle('hidden', !isDupe);
      const dis = v.length === 0 || isDupe || state.busy;
      $('create-btn').disabled = dis;
      $('create-btn').style.background = dis ? 'rgba(25,25,25,.2)' : '#006BD6';
    });
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !$('create-btn').disabled) actions['create-player'](); });
    nameInput.focus();
  }
}

// ---------- avatar menu ----------
function renderAvatarMenu() {
  if (!state.avatarMenu || !me()) { $('menu').innerHTML = ''; return; }
  const idP = me();
  const email = (state.session && state.session.user && state.session.user.email) || (idP.email || '');
  $('menu').innerHTML = `
  <div data-action="menu-backdrop" style="position:fixed;inset:0;z-index:75;max-width:480px;margin:0 auto">
    <div data-stop="1" style="position:absolute;top:60px;right:16px;width:240px;background:#fff;border:1px solid rgba(25,25,25,.1);border-radius:16px;box-shadow:0 16px 40px -12px rgba(25,25,25,.4);overflow:hidden;animation:popIn .16s var(--ease)">
      <div style="padding:14px 16px;display:flex;align-items:center;gap:11px;border-bottom:1px solid rgba(25,25,25,.08)">
        <span style="width:40px;height:40px;border-radius:999px;background:${idP.color};color:${idP.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0">${esc(idP.initials)}</span>
        <div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:700;color:#191919">${esc(idP.name)}</div><div style="font-size:11px;color:rgba(25,25,25,.5);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(email)}</div></div>
      </div>
      ${state.pending ? `<div style="margin:10px 12px 4px;background:#FFF7E0;border:1px solid #F2C94C;border-radius:10px;padding:9px 11px;display:flex;gap:8px"><i class="ph-fill ph-hourglass-medium" style="color:#946A00;font-size:15px;flex-shrink:0;margin-top:1px"></i><span style="font-size:11.5px;line-height:16px;color:#946A00;font-weight:500">Verification pending. You can look around, but logging &amp; disputing unlock once an admin approves you.</span></div>` : ''}
      <button class="tap" data-action="my-profile" style="width:100%;border:none;background:transparent;display:flex;align-items:center;gap:10px;padding:13px 16px;color:#191919;font-size:14px;font-weight:600;text-align:left"><i class="ph-bold ph-user" style="font-size:18px"></i>Your profile</button>
      <button class="tap" data-action="sign-out" style="width:100%;border:none;background:transparent;display:flex;align-items:center;gap:10px;padding:13px 16px;color:#D1334A;font-size:14px;font-weight:600;text-align:left;border-top:1px solid rgba(25,25,25,.06)"><i class="ph-bold ph-sign-out" style="font-size:18px"></i>Sign out</button>
    </div>
  </div>`;
}

// ---------- dispute sheet ----------
function renderDispute() {
  if (!state.disputeFor) { $('dispute').innerHTML = ''; return; }
  const m = state.feed.find(x => x.id === state.disputeFor);
  if (!m) { $('dispute').innerHTML = ''; return; }
  const W = m.winner, L = m.loser;
  const mine = !!(state.identity && (m.winnerId === state.identity || m.loserId === state.identity));
  const disputed = m.status === 'disputed' && !m.isVoided;
  const voided = m.isVoided;
  const counting = !disputed && !voided;

  const summary = `
    <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:18px">
      <div style="width:30px;height:30px;border-radius:999px;background:${W.avatar_color};color:${api.textColorFor(W.avatar_color)};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px">${esc(W.initials)}</div>
      <span style="font-size:14px;font-weight:700;color:#191919">${esc(first(W.name))}</span>
      <span style="font-family:var(--font-mono);font-size:16px;font-weight:700;color:#191919">${m.winnerScore}&ndash;${m.loserScore}</span>
      <span style="font-size:14px;font-weight:700;color:#191919">${esc(first(L.name))}</span>
      <div style="width:30px;height:30px;border-radius:999px;background:${L.avatar_color};color:${api.textColorFor(L.avatar_color)};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px">${esc(L.initials)}</div>
    </div>`;

  let inner = '';
  if (counting && mine && !state.pending) {
    const reasons = [['score', 'Wrong score'], ['nothappen', 'This match never happened'], ['wrongplayer', 'Wrong player picked'], ['other', 'Something else']].map(([k, label]) => {
      const sel = state.disputeReason === k;
      return `
      <button class="tap" data-action="dispute-reason" data-r="${k}" style="display:flex;align-items:center;gap:12px;background:${sel ? '#FDECEF' : '#fff'};border:1.5px solid ${sel ? '#D1334A' : 'rgba(25,25,25,.14)'};border-radius:14px;padding:14px 16px;text-align:left;width:100%">
        <span style="width:20px;height:20px;border-radius:999px;border:2px solid ${sel ? '#D1334A' : 'rgba(25,25,25,.3)'};background:${sel ? '#D1334A' : 'transparent'};flex-shrink:0"></span>
        <span style="font-size:15px;font-weight:700;color:#191919">${label}</span>
      </button>`;
    }).join('');
    inner = `
      <h3 style="font-size:19px;font-weight:700;color:#191919;margin:0 0 4px;text-align:center">What's wrong with this match?</h3>
      <p style="font-size:13px;line-height:19px;color:rgba(25,25,25,.6);font-weight:300;margin:0 0 16px;text-align:center">It goes to the admin to void or keep. The result stays live until they decide — disputing alone doesn't change anyone's ELO.</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">${reasons}</div>
      <button class="tap" data-action="submit-dispute" ${state.disputeReason && !state.busy ? '' : 'disabled'} style="width:100%;height:50px;border:none;border-radius:999px;background:${state.disputeReason ? '#D1334A' : 'rgba(25,25,25,.2)'};color:#fff;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px"><i class="ph-bold ph-flag" style="font-size:18px"></i>Send dispute to the admin</button>
      <button class="tap" data-action="close-dispute" style="width:100%;border:none;background:transparent;color:rgba(25,25,25,.55);font-size:14px;font-weight:700;padding:12px 0 0">Cancel</button>`;
  } else if (counting && mine && state.pending) {
    inner = `
      <div style="text-align:center;padding:0 6px 6px">
        <div style="width:52px;height:52px;border-radius:14px;background:#FFF7E0;display:flex;align-items:center;justify-content:center;margin:0 auto 12px"><i class="ph-fill ph-hourglass-medium" style="color:#946A00;font-size:26px"></i></div>
        <h3 style="font-size:18px;font-weight:700;color:#191919;margin:0 0 6px">Verify to dispute</h3>
        <p style="font-size:13px;line-height:20px;color:rgba(25,25,25,.6);font-weight:300;margin:0 0 16px">Your sign-in is still waiting for admin approval. Once you're verified you can dispute matches you played in.</p>
        <button class="tap" data-action="close-dispute" style="width:100%;height:48px;border:none;border-radius:999px;background:#191919;color:#fff;font-size:15px;font-weight:700">Got it</button>
      </div>`;
  } else if (counting && !mine) {
    inner = `
      <div style="text-align:center;padding:0 6px 6px">
        <div style="width:52px;height:52px;border-radius:14px;background:#F5F5F5;display:flex;align-items:center;justify-content:center;margin:0 auto 12px"><i class="ph-fill ph-lock-simple" style="color:rgba(25,25,25,.45);font-size:26px"></i></div>
        <h3 style="font-size:18px;font-weight:700;color:#191919;margin:0 0 6px">Only the players can dispute</h3>
        <p style="font-size:13px;line-height:20px;color:rgba(25,25,25,.6);font-weight:300;margin:0 0 16px">A match can only be disputed by the two people who played it.</p>
        <button class="tap" data-action="close-dispute" style="width:100%;height:48px;border:none;border-radius:999px;background:#191919;color:#fff;font-size:15px;font-weight:700">Got it</button>
      </div>`;
  } else if (voided) {
    inner = `
      <div style="text-align:center;padding:0 6px 6px">
        <div style="width:52px;height:52px;border-radius:14px;background:#F0F0F0;display:flex;align-items:center;justify-content:center;margin:0 auto 12px"><i class="ph-fill ph-prohibit" style="color:rgba(25,25,25,.5);font-size:26px"></i></div>
        <h3 style="font-size:18px;font-weight:700;color:#191919;margin:0 0 6px">Voided by the admin</h3>
        <p style="font-size:13px;line-height:20px;color:rgba(25,25,25,.6);font-weight:300;margin:0 0 16px">This match no longer counts. Its ELO was reversed for the two players — nobody else was affected.</p>
        <button class="tap" data-action="close-dispute" style="width:100%;height:48px;border:none;border-radius:999px;background:#191919;color:#fff;font-size:15px;font-weight:700">Close</button>
      </div>`;
  } else { // disputed
    const canWithdraw = mine && m.disputedBy === state.identity;
    inner = `
      <div style="text-align:center;padding:0 6px 6px">
        <div style="width:52px;height:52px;border-radius:14px;background:#FFF7E0;display:flex;align-items:center;justify-content:center;margin:0 auto 12px"><i class="ph-fill ph-warning" style="color:#946A00;font-size:26px"></i></div>
        <h3 style="font-size:18px;font-weight:700;color:#191919;margin:0 0 6px">This match is disputed</h3>
        <p style="font-size:13px;line-height:20px;color:rgba(25,25,25,.6);font-weight:300;margin:0 0 12px">It's with the admin to void or keep. The result stays live until they decide.</p>
        <div style="display:inline-flex;align-items:center;gap:6px;background:#FFF7E0;border:1px solid #F2C94C;border-radius:999px;padding:5px 12px;margin-bottom:16px"><span style="font-size:11px;font-weight:700;color:#946A00;text-transform:uppercase;letter-spacing:.4px">Reason:</span><span style="font-size:12px;font-weight:700;color:#946A00">${esc(REASON_LABELS[m.disputeReason] || 'Flagged')}</span></div>
        ${canWithdraw ? '<button class="tap" data-action="withdraw-dispute" style="width:100%;height:48px;border:1.5px solid rgba(25,25,25,.15);background:#fff;border-radius:999px;color:#191919;font-size:15px;font-weight:700;margin-bottom:8px">Withdraw my dispute</button>' : ''}
        <button class="tap" data-action="close-dispute" style="width:100%;border:none;background:transparent;color:rgba(25,25,25,.55);font-size:14px;font-weight:700;padding:8px 0 0">Close</button>
      </div>`;
  }

  $('dispute').innerHTML = `
  <div data-action="dispute-backdrop" style="position:fixed;inset:0;z-index:80;background:rgba(25,25,25,.42);display:flex;flex-direction:column;justify-content:flex-end;max-width:480px;margin:0 auto">
    <div data-stop="1" style="background:#fff;border-radius:24px 24px 0 0;padding:10px 20px 26px;animation:toastIn .22s var(--ease)">
      <div style="width:40px;height:4px;border-radius:999px;background:rgba(25,25,25,.15);margin:0 auto 16px"></div>
      ${summary}
      ${inner}
    </div>
  </div>`;
}

// ---------- toast ----------
function renderToast() {
  $('toast').innerHTML = state.toast ? `
  <div style="position:fixed;bottom:96px;left:50%;transform:translateX(-50%);background:#191919;color:#fff;border-radius:999px;padding:12px 20px;display:flex;align-items:center;gap:8px;box-shadow:0 12px 30px -8px rgba(25,25,25,.6);animation:toastIn .25s var(--ease);white-space:nowrap;z-index:90"><i class="ph-fill ph-check-circle" style="color:#4ADE80;font-size:18px"></i><span style="font-size:14px;font-weight:700">${esc(state.toast)}</span></div>` : '';
}

let toastTimer;
function showToast(text) {
  state.toast = text;
  renderToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = null; renderToast(); }, 2600);
}

// ---------- actions ----------
const actions = {
  'nav': el => {
    const s = el.dataset.screen;
    if (s === 'profile') { openProfile(state.identity); return; }
    state.screen = s;
    state.pickerOpen = null;
    render();
  },
  'open-profile': el => openProfile(el.dataset.id),
  'my-profile': () => { state.avatarMenu = false; openProfile(state.identity); },
  'set-rival': el => { state.rivalId = el.dataset.id; render(); },
  'avatar-menu': () => { state.avatarMenu = !state.avatarMenu; render(); },
  'menu-backdrop': () => { state.avatarMenu = false; render(); },
  'dispute-backdrop': () => { state.disputeFor = null; state.disputeReason = null; render(); },
  'dismiss-event': el => { markEventSeen(el.dataset.id); render(); },

  // ---- auth / claim ----
  'send-link': async () => {
    if (!emailValid(state.authEmail) || state.busy) return;
    state.busy = true; render();
    try {
      await api.sendMagicLink(state.authEmail);
      state.authStep = 'sent';
    } catch (err) {
      showToast('Could not send the link — try again');
      console.error(err);
    } finally { state.busy = false; render(); }
  },
  'oauth': async el => {
    if (state.busy) return;
    state.busy = true; render();
    try {
      await api.signInWithProvider(el.dataset.provider);   // redirects away on success
    } catch (err) {
      state.busy = false;
      showToast(err.message || 'Sign-in failed — is this provider enabled?');
      console.error(err);
      render();
    }
  },
  'change-email': () => { state.authStep = 'email'; render(); },
  'open-create': () => { state.creating = true; state._newName = ''; render(); },
  'cancel-create': () => { state.creating = false; state._newName = ''; render(); },
  'claim-identity': async el => {
    if (state.busy) return;
    const id = el.dataset.id;
    state.busy = true;
    try {
      await api.createClaim(id, state.authEmail);
      state.identity = id; state.pending = true;
      state.authStep = 'email'; state.creating = false;
      await refreshData();
      showToast('Signed in — verification pending');
    } catch (err) {
      showToast('Could not claim that name — try again');
      console.error(err);
    } finally { state.busy = false; render(); }
  },
  'create-player': async () => {
    const name = (($('new-name') || {}).value || state._newName || '').trim();
    if (!name || state.busy) return;
    if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return;
    state.busy = true;
    try {
      const np = await api.addPlayer(name, state.players.length);
      await api.createClaim(np.id, state.authEmail);
      state.identity = np.id; state.pending = true;
      state.creating = false; state._newName = ''; state.authStep = 'email';
      await refreshData();
      showToast('Signed in — verification pending');
    } catch (err) {
      showToast('Could not add you — try again');
      console.error(err);
    } finally { state.busy = false; render(); }
  },
  'sign-out': async () => {
    state.avatarMenu = false;
    try { await api.signOut(); } catch (e) {}
    state.identity = null; state.pending = false; state.session = null;
    state.authStep = 'email'; state.authEmail = ''; state.screen = 'leaderboard';
    render();
  },

  // ---- log ----
  'toggle-picker': el => {
    const w = el.dataset.which;
    state.pickerOpen = state.pickerOpen === w ? null : w;
    state.logSearch = '';
    render();
  },
  'pick-player': el => {
    const { id } = el.dataset;
    if (id !== state.logA) state.logB = id;   // can't pick yourself
    state.pickerOpen = null;
    state.logSearch = '';
    render();
  },
  'clear-search': () => { state.logSearch = ''; render(); },
  'bump': el => {
    const key = el.dataset.which === 'a' ? 'scoreA' : 'scoreB';
    state[key] = Math.max(0, Math.min(21, state[key] + Number(el.dataset.d)));
    render();
  },
  'submit-match': async () => {
    const { logA, logB, scoreA, scoreB } = state;
    if (!logA || !logB || logA === logB || !validScore(scoreA, scoreB) || state.busy || !canAct()) return;
    const aWon = scoreA > scoreB;
    state.busy = true; render();
    try {
      const result = await api.logMatch({
        winnerId: aWon ? logA : logB,
        loserId: aWon ? logB : logA,
        winnerScore: aWon ? scoreA : scoreB,
        loserScore: aWon ? scoreB : scoreA,
        enteredBy: state.identity,
      });
      const wName = first(P(aWon ? logA : logB).name);
      await refreshData();
      state.screen = 'feed';
      state.pickerOpen = null;
      state.logSearch = '';
      state.scoreA = 11; state.scoreB = 0; state.logB = null;
      showToast(`${wName} wins! +${result.elo_delta} ELO`);
    } catch (err) {
      showToast(err.message || 'Could not record match');
      console.error(err);
    } finally { state.busy = false; render(); }
  },
  'react': async el => {
    const { id, kind } = el.dataset;
    const m = state.feed.find(x => x.id === id);
    if (m) { m.reactions[kind]++; render(); }
    try { await api.addReaction(id, kind); } catch (err) { console.error(err); }
  },
  'toggle-comments': el => {
    const id = el.dataset.id;
    state.openComments.has(id) ? state.openComments.delete(id) : state.openComments.add(id);
    render();
  },
  'send-comment': async el => {
    const id = el.dataset.id;
    const input = $('draft-' + id);
    const text = (input && input.value || '').trim();
    if (!text || !canAct()) return;
    input.value = '';
    try {
      await api.postComment(id, state.identity, text);
      await refreshData();
      render();
      const again = $('draft-' + id);
      if (again) again.focus();
    } catch (err) {
      showToast('Comment failed');
      console.error(err);
    }
  },

  // ---- dispute sheet ----
  'open-dispute': el => { state.disputeFor = el.dataset.id; state.disputeReason = null; render(); },
  'close-dispute': () => { state.disputeFor = null; state.disputeReason = null; render(); },
  'dispute-reason': el => { state.disputeReason = el.dataset.r; render(); },
  'submit-dispute': async () => {
    if (!state.disputeFor || !state.disputeReason || state.busy) return;
    state.busy = true;
    const id = state.disputeFor, reason = state.disputeReason;
    try {
      await api.disputeMatch(id, reason);
      state.disputeFor = null; state.disputeReason = null;
      await refreshData();
      showToast('Dispute sent to the admin');
    } catch (err) {
      showToast(err.message || 'Could not send dispute');
      console.error(err);
    } finally { state.busy = false; render(); }
  },
  'withdraw-dispute': async () => {
    if (!state.disputeFor || state.busy) return;
    state.busy = true;
    const id = state.disputeFor;
    try {
      await api.withdrawDispute(id);
      state.disputeFor = null; state.disputeReason = null;
      await refreshData();
      showToast('Dispute withdrawn');
    } catch (err) {
      showToast(err.message || 'Could not withdraw');
      console.error(err);
    } finally { state.busy = false; render(); }
  },

  // ---- admin ----
  'resolve': async el => {
    if (state.busy) return;
    const id = el.dataset.id, act = el.dataset.act;
    state.busy = true; render();
    try {
      await api.resolveDispute(id, act);
      await refreshData();
      showToast(act === 'uphold' ? 'Result upheld — stays live'
        : act === 'void_penalize' ? 'Voided + −50 penalty' : 'Match voided — ELO reversed');
    } catch (err) {
      showToast(err.message || 'Could not resolve');
      console.error(err);
    } finally { state.busy = false; render(); }
  },
  'approve-claim': async el => {
    if (state.busy) return;
    state.busy = true; render();
    try {
      await api.approveClaim(el.dataset.id);
      await refreshData();
      showToast('Claim approved — email bound');
    } catch (err) {
      showToast(err.message || 'Could not approve');
      console.error(err);
    } finally { state.busy = false; render(); }
  },
  'reject-claim': async el => {
    if (state.busy) return;
    state.busy = true; render();
    try {
      await api.rejectClaim(el.dataset.id);
      await refreshData();
      showToast('Claim rejected');
    } catch (err) {
      showToast(err.message || 'Could not reject');
      console.error(err);
    } finally { state.busy = false; render(); }
  },
  'toggle-rollout': async () => {
    if (state.busy) return;
    state.busy = true; render();
    try {
      await api.setRolloutComplete(!state.rolloutComplete);
      state.rolloutComplete = !state.rolloutComplete;
    } catch (err) {
      showToast(err.message || 'Could not update rollout');
      console.error(err);
    } finally { state.busy = false; render(); }
  },
};

async function openProfile(id) {
  state.avatarMenu = false;
  if (!id) { state.screen = 'profile'; render(); return; }
  state.screen = 'profile';
  state.profileId = id;
  state.profileData = null;
  state.rivalId = null;   // defaults to the most-played opponent
  render();
  try {
    state.profileData = await api.getPlayerDetail(id, state.season.id);
  } catch (err) {
    console.error(err);
    state.profileData = { standing: {}, history: [], matches: [] };
  }
  render();
}

document.addEventListener('click', e => {
  const stop = e.target.closest('[data-stop]');
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  // clicks inside a menu/sheet card shouldn't fall through to the backdrop's close action
  if (stop && (el.dataset.action === 'menu-backdrop' || el.dataset.action === 'dispute-backdrop')) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset && e.target.dataset.draft) {
    actions['send-comment']({ dataset: { id: e.target.dataset.draft } });
  }
});

// ---------- realtime ----------
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      await refreshData();
      const a = document.activeElement;
      if (!a || (!a.dataset.draft && a.id !== 'new-name' && a.id !== 'auth-email' && a.id !== 'opp-search')) render();
    } catch (e) { console.error(e); }
  }, 400);
}

// ---------- boot ----------
(async function init() {
  if (SUPABASE_ANON_KEY.includes('PASTE')) {
    state.loading = false;
    state.error = 'Missing Supabase anon key — set it in js/config.js.';
    render();
    return;
  }
  render();
  try {
    await loadCore();
    const session = await api.getSession();
    await resolveSession(session);
    if (state.identity) { try { await refreshData(); } catch (e) { console.error(e); } }
    // react to magic-link redirect completing, or sign-out, in any tab
    api.onAuthChange(async newSession => {
      await resolveSession(newSession);
      try { await refreshData(); } catch (e) { console.error(e); }
      render();
    });
    api.subscribeToChanges(scheduleRefresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(); });
  } catch (err) {
    state.loading = false;
    state.error = err.message || String(err);
    console.error(err);
  }
  render();
})();
