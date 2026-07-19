// EF Pong — phone app. Faithful port of the design prototype, wired to Supabase.
import * as api from './api.js';
import { SUPABASE_ANON_KEY } from './config.js';

// ---------- state ----------
const state = {
  season: null,
  players: [],          // leaderboard rows, sorted by elo desc
  history: [],          // rating_history rows (move indicators)
  feed: [],
  screen: 'leaderboard',
  identity: null,
  switching: false,
  creating: false,
  profileId: null,
  profileData: null,
  rivalId: null,
  pickerOpen: null,     // 'a' | 'b' | null
  logA: null,
  logB: null,
  scoreA: 11,
  scoreB: 0,
  openComments: new Set(),
  toast: null,
  loading: true,
  error: null,
  busy: false,
};

try { state.identity = localStorage.getItem('efpong_identity'); } catch (e) {}

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

function fmtTime(iso) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 60) return min + 'm ago';
  if (min < 1440) return Math.round(min / 60) + 'h ago';
  return Math.round(min / 1440) + 'd ago';
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
  if (state.identity && !P(state.identity)) {
    state.identity = null;
    try { localStorage.removeItem('efpong_identity'); } catch (e) {}
  }
  if (state.identity && !state.logA) state.logA = state.identity;
  state.loading = false;
}

async function refreshData() {
  const [players, feed, history] = await Promise.all([
    api.getLeaderboard(state.season.id),
    api.getFeed(state.season.id),
    api.supabase.from('rating_history')
      .select('player_id, rating_after, recorded_at')
      .order('recorded_at', { ascending: true }).limit(5000)
      .then(r => { if (r.error) throw r.error; return r.data; }),
  ]);
  state.players = players;
  state.feed = feed;
  state.history = history;
}

// ---------- rendering ----------
const $ = id => document.getElementById(id);

function render() {
  renderHeader();
  renderView();
  renderNav();
  renderGate();
  renderToast();
}

function renderHeader() {
  const idP = state.identity ? P(state.identity) : null;
  $('header').innerHTML = `
  <div style="background:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--hairline);position:sticky;top:0;z-index:10">
    <div style="display:flex;align-items:center;gap:9px">
      <div style="width:30px;height:30px;border-radius:8px;background:#006BD6;display:flex;align-items:center;justify-content:center"><i class="ph-fill ph-ping-pong" style="color:#fff;font-size:19px"></i></div>
      <span style="font-size:20px;font-weight:900;letter-spacing:-.5px;color:#191919">EF Pong</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      ${idP ? `<button class="tap" data-action="switch-identity" title="Switch player" style="border:none;background:transparent;padding:0;width:36px;height:36px;border-radius:999px;display:flex;align-items:center;justify-content:center"><span style="width:34px;height:34px;border-radius:999px;background:${idP.color};color:${idP.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;border:2px solid #E5F3FF">${esc(idP.initials)}</span></button>` : ''}
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
  $('nav').innerHTML = `
  <div style="background:#fff;border-top:1px solid var(--hairline);display:flex;padding:8px 8px calc(10px + env(safe-area-inset-bottom));position:sticky;bottom:0;z-index:10">
    ${tabs.map(t => `
      <button class="tap" data-action="nav" data-screen="${t.id}" style="flex:1;border:none;background:transparent;display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px 0;color:${t.id === state.screen ? '#006BD6' : 'rgba(25,25,25,.4)'}">
        <i class="${t.icon}" style="font-size:24px"></i>
        <span style="font-size:10px;font-weight:700;letter-spacing:.2px">${t.label}</span>
      </button>`).join('')}
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
  const views = { leaderboard: viewLeaderboard, log: viewLog, feed: viewFeed, profile: viewProfile };
  $('view').innerHTML = views[state.screen]();
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
      <div style="font-size:12px;color:rgba(25,25,25,.6);font-weight:300;margin-top:2px">Tap your avatar &rarr; &ldquo;I'm new&rdquo; to add more players.</div>
    </div>` : ''}
  </div>`;
}

// ---------- log a match ----------
function viewLog() {
  const slot = which => {
    const id = which === 'a' ? state.logA : state.logB;
    const p = id ? P(id) : null;
    const open = state.pickerOpen === which;
    const other = which === 'a' ? state.logB : state.logA;
    const options = state.players.filter(o => o.id !== other).map(o => `
      <button class="tap" data-action="pick-player" data-which="${which}" data-id="${esc(o.id)}" style="width:100%;display:flex;align-items:center;gap:10px;background:${o.id === id ? '#E5F3FF' : '#fff'};border:none;border-bottom:1px solid rgba(25,25,25,.06);padding:9px 14px;text-align:left">
        ${avatar(o, 30, 11)}
        <span style="flex:1;font-size:14px;font-weight:500;color:#191919">${esc(o.name)}</span>
        <span style="font-family:var(--font-mono);font-size:12px;color:rgba(25,25,25,.45)">${o.elo}</span>
      </button>`).join('');
    return `
    <div>
      <div style="font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:rgba(25,25,25,.5);margin:0 0 6px 2px">${which === 'a' ? 'Player 1' : 'Player 2'}</div>
      <button class="tap" data-action="toggle-picker" data-which="${which}" style="width:100%;display:flex;align-items:center;gap:12px;background:#fff;border:1.5px solid ${open ? '#006BD6' : 'rgba(25,25,25,.12)'};border-radius:14px;padding:12px 14px;text-align:left">
        <div style="width:40px;height:40px;border-radius:999px;background:${p ? p.color : '#E0E0E0'};color:${p ? p.textColor : 'rgba(25,25,25,.5)'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0">${p ? esc(p.initials) : '?'}</div>
        <span style="flex:1;font-size:16px;font-weight:700;color:${p ? '#191919' : 'rgba(25,25,25,.4)'}">${p ? esc(p.name) : 'Select player'}</span>
        <i class="ph-bold ph-caret-down" style="font-size:16px;color:rgba(25,25,25,.4)"></i>
      </button>
      ${open ? `<div class="app-scroll" style="background:#fff;border:1px solid rgba(25,25,25,.1);border-radius:14px;margin-top:6px;max-height:220px;overflow-y:auto;box-shadow:0 12px 28px -14px rgba(25,25,25,.5)">${options}</div>` : ''}
    </div>`;
  };

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

  // preview
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
    <h1 style="font-size:28px;font-weight:700;color:#191919;margin:0 0 2px;letter-spacing:-.5px">Log a match</h1>
    <p style="margin:0 0 18px;font-size:13px;color:rgba(25,25,25,.55);font-weight:300">Enter the game you just played.</p>
    <div style="display:flex;flex-direction:column;gap:10px">${slot('a')}${slot('b')}</div>
    <div style="font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:rgba(25,25,25,.5);margin:20px 0 8px 2px">Score</div>
    <div style="display:flex;gap:12px">
      ${scoreCard('a', scName(state.logA, 'Player 1'), state.scoreA, state.scoreA >= state.scoreB)}
      ${scoreCard('b', scName(state.logB, 'Player 2'), state.scoreB, state.scoreB > state.scoreA)}
    </div>
    ${preview}
    <button class="tap" data-action="submit-match" ${valid && !state.busy ? '' : 'disabled'} style="margin-top:18px;width:100%;height:54px;border:none;border-radius:999px;background:${valid && !state.busy ? '#006BD6' : 'rgba(25,25,25,.2)'};color:#fff;font-size:16px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px"><i class="ph-bold ph-check-circle" style="font-size:20px"></i>${state.busy ? 'Recording…' : 'Record match'}</button>
  </div>`;
}

// ---------- feed ----------
function viewFeed() {
  if (!state.feed.length) {
    return `
    <div style="padding:20px 16px 28px">
      <h1 style="font-size:28px;font-weight:700;color:#191919;margin:0 0 2px;letter-spacing:-.5px">Match feed</h1>
      <p style="margin:0 0 18px;font-size:13px;color:rgba(25,25,25,.55);font-weight:300">Every game, live. React and talk trash.</p>
      <div style="text-align:center;padding:40px 22px;background:#fff;border:1px solid var(--hairline);border-radius:16px">
        <div style="width:56px;height:56px;border-radius:16px;background:#F5F5F5;display:flex;align-items:center;justify-content:center;margin:0 auto 14px"><i class="ph ph-ping-pong" style="color:rgba(25,25,25,.35);font-size:30px"></i></div>
        <div style="font-size:16px;font-weight:700;color:#191919">No matches yet</div>
        <div style="font-size:13px;color:rgba(25,25,25,.55);font-weight:300;margin-top:4px">Play a game, then log it &mdash; it'll show up here for everyone to react to.</div>
      </div>
    </div>`;
  }

  const cards = state.feed.map(m => {
    const open = state.openComments.has(m.id);
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
      ${m.upset ? '<div style="background:#DA2381;color:#fff;font-size:11px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;padding:5px 16px;display:flex;align-items:center;gap:6px"><i class="ph-fill ph-lightning"></i>Upset of the day</div>' : ''}
      <div style="padding:14px 16px 12px">
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
        </div>
        ${open ? `
        <div style="margin-top:10px;border-top:1px solid rgba(25,25,25,.07);padding-top:10px;display:flex;flex-direction:column;gap:8px">
          ${comments}
          <div style="display:flex;gap:8px;align-items:center;margin-top:2px">
            <input id="draft-${esc(m.id)}" data-draft="${esc(m.id)}" placeholder="Add some trash talk…" style="flex:1;height:38px;border:1px solid rgba(25,25,25,.15);border-radius:999px;padding:0 14px;font-size:13px;color:#191919;outline:none" />
            <button class="tap" data-action="send-comment" data-id="${esc(m.id)}" style="width:38px;height:38px;border-radius:999px;border:none;background:#006BD6;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="ph-bold ph-paper-plane-right" style="font-size:16px"></i></button>
          </div>
        </div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `
  <div style="padding:20px 16px 28px">
    <h1 style="font-size:28px;font-weight:700;color:#191919;margin:0 0 2px;letter-spacing:-.5px">Match feed</h1>
    <p style="margin:0 0 18px;font-size:13px;color:rgba(25,25,25,.55);font-weight:300">Every game, live. React and talk trash.</p>
    <div style="display:flex;flex-direction:column;gap:14px">${cards}</div>
  </div>`;
}

// ---------- profile ----------
function viewProfile() {
  const pp = P(state.profileId || state.identity);
  if (!pp) return `<div style="padding:40px;text-align:center;color:rgba(25,25,25,.45)">Pick your name first.</div>`;
  const d = state.profileData;
  if (!d) return `<div style="padding:60px 20px;text-align:center;color:rgba(25,25,25,.45);font-size:14px;font-weight:300">Loading…</div>`;

  // spark line from rating history
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

  // head-to-head
  const rivalsList = state.players.filter(p => p.id !== pp.id).slice(0, 6);
  const rival = P(state.rivalId) && state.rivalId !== pp.id ? P(state.rivalId) : rivalsList[0];
  let myWins = 0, theirWins = 0;
  if (rival) {
    d.matches.forEach(m => {
      if (m.winner_id === pp.id && m.loser_id === rival.id) myWins++;
      else if (m.winner_id === rival.id && m.loser_id === pp.id) theirWins++;
    });
  }
  let verdict, vColor;
  if (myWins > theirWins) { verdict = `${first(pp.name)} leads ${myWins}–${theirWins}`; vColor = '#008928'; }
  else if (theirWins > myWins) { verdict = `${first(rival.name)} leads ${theirWins}–${myWins}`; vColor = '#D1334A'; }
  else if (myWins === 0) { verdict = 'No matches yet — book a game'; vColor = 'rgba(25,25,25,.5)'; }
  else { verdict = `All square, ${myWins}–${theirWins}`; vColor = 'rgba(25,25,25,.6)'; }

  const rivalChips = rivalsList.map(r => `
    <button class="tap" data-action="set-rival" data-id="${esc(r.id)}" style="border:1px solid ${rival && r.id === rival.id ? '#006BD6' : 'rgba(25,25,25,.15)'};background:${rival && r.id === rival.id ? '#006BD6' : '#fff'};color:${rival && r.id === rival.id ? '#fff' : '#191919'};border-radius:999px;height:30px;padding:0 12px;font-size:12px;font-weight:700">${esc(first(r.name))}</button>`).join('');

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

    ${rival ? `
    <div style="font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:rgba(25,25,25,.5);margin:22px 0 8px 2px">Head-to-head</div>
    <div style="background:#fff;border:1px solid var(--hairline);border-radius:16px;padding:16px">
      <div style="display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px">${rivalChips}</div>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="text-align:center;flex:1"><div style="font-family:var(--font-mono);font-size:32px;font-weight:700;color:#006BD6">${myWins}</div><div style="font-size:12px;font-weight:700;color:#191919">${esc(first(pp.name))}</div></div>
        <div style="font-size:13px;font-weight:900;color:rgba(25,25,25,.35)">vs</div>
        <div style="text-align:center;flex:1"><div style="font-family:var(--font-mono);font-size:32px;font-weight:700;color:#191919">${theirWins}</div><div style="font-size:12px;font-weight:700;color:#191919">${esc(first(rival.name))}</div></div>
      </div>
      <div style="text-align:center;margin-top:8px;font-size:13px;font-weight:500;color:${vColor}">${esc(verdict)}</div>
    </div>` : ''}

    <div style="font-size:11px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:rgba(25,25,25,.5);margin:22px 0 8px 2px">Recent matches</div>
    <div style="display:flex;flex-direction:column;gap:8px">${recent}</div>
  </div>`;
}

// ---------- identity gate ----------
function renderGate() {
  const show = !state.loading && !state.error && (!state.identity || state.switching);
  if (!show) { $('gate').innerHTML = ''; return; }

  const creating = state.creating || state.players.length === 0;
  const canClose = !!state.identity;
  const empty = state.players.length === 0;
  const newName = ($('new-name') && $('new-name').value) || state._newName || '';
  const nm = newName.trim();
  const dupe = nm.length > 0 && state.players.some(p => p.name.toLowerCase() === nm.toLowerCase());
  const disabled = nm.length === 0 || dupe || state.busy;
  const PAL = [['#006BD6', '#fff'], ['#DA2381', '#fff'], ['#008928', '#fff'], ['#FAB005', '#191919'], ['#D1334A', '#fff'], ['#191919', '#fff'], ['#0369A1', '#fff'], ['#C2410C', '#fff']];
  const [ncBg, ncText] = PAL[state.players.length % PAL.length];

  const options = state.players.map(p => `
    <button class="tap" data-action="pick-identity" data-id="${esc(p.id)}" style="display:flex;align-items:center;gap:12px;background:${p.id === state.identity ? '#E5F3FF' : '#fff'};border:1.5px solid ${p.id === state.identity ? 'rgba(0,107,214,.4)' : 'var(--hairline)'};border-radius:14px;padding:11px 14px;text-align:left;width:100%">
      ${avatar(p, 40, 14)}
      <span style="flex:1;font-size:16px;font-weight:700;color:#191919">${esc(p.name)}</span>
      <span style="font-family:var(--font-mono);font-size:13px;color:rgba(25,25,25,.45)">${p.elo}</span>
    </button>`).join('');

  $('gate').innerHTML = `
  <div style="position:fixed;inset:0;z-index:70;background:#fff;display:flex;flex-direction:column;max-width:480px;margin:0 auto">
    <div style="padding:28px 26px 18px;flex-shrink:0">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:26px">
        <div style="width:34px;height:34px;border-radius:9px;background:#006BD6;display:flex;align-items:center;justify-content:center"><i class="ph-fill ph-ping-pong" style="color:#fff;font-size:21px"></i></div>
        <span style="font-size:22px;font-weight:900;letter-spacing:-.5px;color:#191919">EF Pong</span>
        ${canClose ? '<button class="tap" data-action="close-gate" style="margin-left:auto;border:none;background:#F5F5F5;width:34px;height:34px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:#191919"><i class="ph-bold ph-x" style="font-size:16px"></i></button>' : ''}
      </div>
      <h1 style="font-size:26px;font-weight:700;color:#191919;margin:0 0 6px;letter-spacing:-.5px">Who are you?</h1>
      <p style="margin:0;font-size:14px;line-height:20px;color:rgba(25,25,25,.6);font-weight:300">Pick your name so your matches and comments are yours &mdash; or add yourself if you're new. No password &mdash; secure sign-in comes later.</p>
    </div>
    <div class="app-scroll" style="flex:1;overflow-y:auto;padding:4px 18px 20px;display:flex;flex-direction:column;gap:8px">
      ${creating ? `
        ${empty ? `
        <div style="text-align:center;padding:14px 8px 4px">
          <div style="width:52px;height:52px;border-radius:14px;background:#E5F3FF;display:flex;align-items:center;justify-content:center;margin:0 auto 12px"><i class="ph-fill ph-confetti" style="color:#006BD6;font-size:26px"></i></div>
          <div style="font-size:16px;font-weight:700;color:#191919">No players yet</div>
          <div style="font-size:13px;color:rgba(25,25,25,.55);font-weight:300;margin-top:2px">Be the first &mdash; add yourself to start the ladder.</div>
        </div>` : ''}
        <div style="background:#fff;border:1.5px solid rgba(0,107,214,.25);border-radius:16px;padding:18px 16px;display:flex;flex-direction:column;align-items:center;gap:14px">
          <div id="nc-avatar" style="width:64px;height:64px;border-radius:999px;background:${ncBg};color:${ncText};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px">${nm ? esc(api.mkInitials(nm)) : '?'}</div>
          <input id="new-name" value="${esc(newName)}" placeholder="Type your full name" autocomplete="off" style="width:100%;height:46px;border:1.5px solid rgba(25,25,25,.15);border-radius:12px;padding:0 14px;font-size:16px;font-weight:500;color:#191919;outline:none;text-align:center" />
          <div id="dupe-warn" class="${dupe ? '' : 'hidden'}" style="display:flex;align-items:center;gap:6px;color:#946A00;font-size:12px;font-weight:500;text-align:center"><i class="ph-fill ph-warning-circle" style="font-size:15px;flex-shrink:0"></i><span>Someone already has that name &mdash; add a last initial to tell you apart.</span></div>
          <button id="create-btn" class="tap" data-action="create-player" ${disabled ? 'disabled' : ''} style="width:100%;height:48px;border:none;border-radius:999px;background:${disabled ? 'rgba(25,25,25,.2)' : '#006BD6'};color:#fff;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px"><i class="ph-bold ph-user-plus" style="font-size:18px"></i>Add me &amp; continue</button>
          <p style="margin:0;font-size:11px;color:rgba(25,25,25,.45);font-weight:300;text-align:center">You'll start at 1000 ELO, like everyone else.</p>
        </div>
        ${state.creating && state.players.length > 0 ? '<button class="tap" data-action="cancel-create" style="border:none;background:transparent;color:rgba(25,25,25,.55);font-size:13px;font-weight:700;padding:6px 0">Back to the list</button>' : ''}
      ` : `
        <button class="tap" data-action="open-create" style="display:flex;align-items:center;justify-content:center;gap:8px;background:#E5F3FF;border:1.5px dashed rgba(0,107,214,.4);border-radius:14px;padding:12px 14px;width:100%;color:#006BD6;font-size:14px;font-weight:700"><i class="ph-bold ph-user-plus" style="font-size:18px"></i>I'm new &mdash; add me</button>
        ${options}
      `}
    </div>
  </div>`;

  // live initials + dupe check without re-render (keeps input focus)
  const input = $('new-name');
  if (input) {
    input.addEventListener('input', () => {
      state._newName = input.value;
      const v = input.value.trim();
      $('nc-avatar').textContent = v ? api.mkInitials(v) : '?';
      const isDupe = v.length > 0 && state.players.some(p => p.name.toLowerCase() === v.toLowerCase());
      $('dupe-warn').classList.toggle('hidden', !isDupe);
      const dis = v.length === 0 || isDupe;
      $('create-btn').disabled = dis;
      $('create-btn').style.background = dis ? 'rgba(25,25,25,.2)' : '#006BD6';
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !$('create-btn').disabled) actions['create-player'](); });
    if (!state.identity) input.focus();
  }
}

// ---------- toast ----------
function renderToast() {
  $('toast').innerHTML = state.toast ? `
  <div style="position:fixed;bottom:96px;left:50%;transform:translateX(-50%);background:#191919;color:#fff;border-radius:999px;padding:12px 20px;display:flex;align-items:center;gap:8px;box-shadow:0 12px 30px -8px rgba(25,25,25,.6);animation:toastIn .25s var(--ease);white-space:nowrap;z-index:80"><i class="ph-fill ph-check-circle" style="color:#4ADE80;font-size:18px"></i><span style="font-size:14px;font-weight:700">${esc(state.toast)}</span></div>` : '';
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
    if (s === 'profile') {
      state.profileId = state.identity;
      openProfile(state.identity);
      return;
    }
    state.screen = s;
    state.pickerOpen = null;
    render();
  },
  'open-profile': el => openProfile(el.dataset.id),
  'set-rival': el => { state.rivalId = el.dataset.id; render(); },
  'switch-identity': () => { state.switching = true; render(); },
  'close-gate': () => { state.switching = false; state.creating = false; render(); },
  'open-create': () => { state.creating = true; state._newName = ''; render(); },
  'cancel-create': () => { state.creating = false; state._newName = ''; render(); },
  'pick-identity': el => {
    state.identity = el.dataset.id;
    try { localStorage.setItem('efpong_identity', state.identity); } catch (e) {}
    state.switching = false;
    if (!state.logA) state.logA = state.identity;
    render();
  },
  'create-player': async () => {
    const name = (($('new-name') || {}).value || '').trim();
    if (!name || state.busy) return;
    if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return;
    state.busy = true;
    try {
      const np = await api.addPlayer(name, state.players.length);
      state.identity = np.id;
      try { localStorage.setItem('efpong_identity', np.id); } catch (e) {}
      state.creating = false; state.switching = false; state._newName = '';
      if (!state.logA) state.logA = np.id;
      await refreshData();
      showToast(`Welcome, ${first(np.name)}! You start at 1000.`);
    } catch (err) {
      showToast('Could not add you — try again');
      console.error(err);
    } finally {
      state.busy = false;
      render();
    }
  },
  'toggle-picker': el => {
    const w = el.dataset.which;
    state.pickerOpen = state.pickerOpen === w ? null : w;
    render();
  },
  'pick-player': el => {
    const { which, id } = el.dataset;
    const other = which === 'a' ? state.logB : state.logA;
    if (id !== other) {
      if (which === 'a') state.logA = id; else state.logB = id;
    }
    state.pickerOpen = null;
    render();
  },
  'bump': el => {
    const key = el.dataset.which === 'a' ? 'scoreA' : 'scoreB';
    state[key] = Math.max(0, Math.min(21, state[key] + Number(el.dataset.d)));
    render();
  },
  'submit-match': async () => {
    const { logA, logB, scoreA, scoreB } = state;
    if (!logA || !logB || logA === logB || !validScore(scoreA, scoreB) || state.busy) return;
    const aWon = scoreA > scoreB;
    state.busy = true;
    render();
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
      state.scoreA = 11; state.scoreB = 0; state.logB = null;
      showToast(`${wName} wins! +${result.elo_delta} ELO`);
    } catch (err) {
      showToast('Could not record match');
      console.error(err);
    } finally {
      state.busy = false;
      render();
    }
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
    if (!text || !state.identity) return;
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
};

async function openProfile(id) {
  if (!id) { state.screen = 'profile'; render(); return; }
  state.screen = 'profile';
  state.profileId = id;
  state.profileData = null;
  const others = state.players.filter(p => p.id !== id);
  state.rivalId = others.length ? others[0].id : null;
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
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
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
      // don't clobber typing: skip re-render if a draft input is focused
      const a = document.activeElement;
      if (!a || (!a.dataset.draft && a.id !== 'new-name')) render();
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
    api.subscribeToChanges(scheduleRefresh);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) scheduleRefresh();
    });
  } catch (err) {
    state.loading = false;
    state.error = err.message || String(err);
    console.error(err);
  }
  render();
})();
