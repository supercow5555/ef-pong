// EF Pong — wall display. Realtime with a ~10s polling fallback; redraws from
// fresh reads every time so a screen left on all quarter stays healthy.
import * as api from './api.js';

let season = null;
let players = [];
let feed = [];
let history = [];
let prevChampion = null;
let realtimeUp = false;
let pollTimer = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const first = n => (n || '').split(' ')[0];

function fmtTime(iso) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 60) return min + 'm';
  if (min < 1440) return Math.round(min / 60) + 'h';
  return Math.round(min / 1440) + 'd';
}

function eloAt(playerId, cutoffMs) {
  let last = null;
  for (const h of history) {
    if (h.player_id !== playerId) continue;
    if (new Date(h.recorded_at).getTime() > cutoffMs) break;
    last = h.rating_after;
  }
  return last ?? 1000;
}

async function refresh() {
  if (!season) season = await api.getActiveSeason();
  const [p, f, h, prevSeason] = await Promise.all([
    api.getLeaderboard(season.id),
    api.getFeed(season.id, 8),
    api.supabase.from('rating_history')
      .select('player_id, rating_after, recorded_at')
      .order('recorded_at', { ascending: true }).limit(5000)
      .then(r => { if (r.error) throw r.error; return r.data; }),
    api.supabase.from('season')
      .select('champion_id, champion:player(name, initials)')
      .eq('is_active', false).not('champion_id', 'is', null)
      .order('ends_at', { ascending: false }).limit(1).maybeSingle()
      .then(r => { if (r.error) throw r.error; return r.data; }),
  ]);
  players = p; feed = f; history = h;
  prevChampion = prevSeason;
  draw();
}

function draw() {
  document.getElementById('season-label').textContent = season.name;
  const cutoff = Date.now() - 24 * 3600 * 1000;

  const rows = players.slice(0, 8).map((p, i) => {
    const rank = i + 1;
    const d = p.elo - eloAt(p.id, cutoff);
    const mv = d > 0
      ? { icon: 'ph-fill ph-caret-up', color: '#4ADE80', text: '+' + d }
      : d < 0
        ? { icon: 'ph-fill ph-caret-down', color: '#F87171', text: '' + Math.abs(d) }
        : { icon: 'ph-bold ph-minus', color: 'rgba(255,255,255,.4)', text: '0' };
    return `
    <div style="display:flex;align-items:center;gap:20px;background:${rank === 1 ? 'rgba(250,176,5,.1)' : 'rgba(255,255,255,.04)'};border:1px solid ${rank === 1 ? 'rgba(250,176,5,.4)' : 'rgba(255,255,255,.09)'};border-radius:16px;padding:14px 22px">
      <div style="width:40px;font-family:var(--font-mono);font-size:28px;font-weight:700;color:${rank === 1 ? '#FAB005' : rank <= 3 ? '#006BD6' : 'rgba(255,255,255,.5)'};text-align:center;flex-shrink:0">${rank}</div>
      <div style="width:52px;height:52px;border-radius:999px;background:${p.color};color:${p.textColor};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;flex-shrink:0">${esc(p.initials)}</div>
      <div style="flex:1;font-size:24px;font-weight:700;color:#fff">${esc(p.name)}</div>
      <div style="display:flex;align-items:center;gap:5px;color:${mv.color}"><i class="${mv.icon}" style="font-size:18px"></i><span style="font-size:16px;font-weight:700">${mv.text}</span></div>
      <div style="font-size:18px;color:rgba(255,255,255,.5);font-family:var(--font-mono);width:80px;text-align:right">${p.wins}&ndash;${p.losses}</div>
      <div style="font-family:var(--font-mono);font-size:32px;font-weight:700;color:#fff;width:90px;text-align:right">${p.elo}</div>
    </div>`;
  }).join('') || `<div style="color:rgba(255,255,255,.4);font-size:18px;font-weight:300;padding:24px">No players yet &mdash; open the app and add yourself.</div>`;

  // champion card: last closed season's champion, else the current leader
  const leader = players[0];
  const champName = prevChampion && prevChampion.champion ? prevChampion.champion.name : leader ? leader.name : '—';
  const champInitials = prevChampion && prevChampion.champion ? prevChampion.champion.initials : leader ? leader.initials : '?';
  const champLabel = prevChampion && prevChampion.champion ? 'Reigning champion' : 'Current leader';
  const champStats = leader ? `${leader.elo} ELO &middot; ${leader.wins}&ndash;${leader.losses}` : '';

  let mover = null;
  for (const p of players) {
    const d = p.elo - eloAt(p.id, cutoff);
    if (!mover || d > mover.d) mover = { name: p.name, d };
  }

  const ticker = feed.slice(0, 5).map(m => `
    <div style="display:flex;align-items:center;gap:10px;animation:tickerRow .4s var(--ease)">
      <span style="font-size:16px;font-weight:700;color:#fff;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(first(m.winner.name))} def. ${esc(first(m.loser.name))} ${m.winnerScore}&ndash;${m.loserScore}</span>
      <span style="font-family:var(--font-mono);font-size:15px;font-weight:700;color:#4ADE80">+${m.delta}</span>
      <span style="font-size:13px;color:rgba(255,255,255,.4);width:52px;text-align:right">${fmtTime(m.playedAt)}</span>
    </div>`).join('') || '<div style="color:rgba(255,255,255,.35);font-size:15px;font-weight:300">No matches yet.</div>';

  document.getElementById('wall-body').innerHTML = `
  <div style="flex:1.35;display:flex;flex-direction:column;min-height:0">
    <div style="font-size:14px;font-weight:900;letter-spacing:2px;color:rgba(255,255,255,.5);text-transform:uppercase;margin-bottom:16px">Standings</div>
    <div style="display:flex;flex-direction:column;gap:10px;overflow:hidden">${rows}</div>
  </div>
  <div style="flex:1;display:flex;flex-direction:column;gap:20px;min-height:0">
    <div style="background:linear-gradient(135deg,#006BD6,#0052A3);border-radius:20px;padding:24px;position:relative;overflow:hidden">
      <div style="font-size:13px;font-weight:900;letter-spacing:2px;color:rgba(255,255,255,.7);text-transform:uppercase">${champLabel}</div>
      <div style="display:flex;align-items:center;gap:16px;margin-top:14px">
        <div style="width:64px;height:64px;border-radius:999px;background:#fff;color:#006BD6;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px;position:relative">${esc(champInitials)}<i class="ph-fill ph-crown-simple" style="position:absolute;top:-14px;left:50%;transform:translateX(-50%);color:#FAB005;font-size:26px"></i></div>
        <div><div style="font-size:28px;font-weight:900;color:#fff;line-height:1">${esc(champName)}</div><div style="font-family:var(--font-mono);font-size:16px;color:rgba(255,255,255,.85)">${champStats}</div></div>
      </div>
    </div>
    <div style="background:rgba(218,35,129,.14);border:1px solid rgba(218,35,129,.4);border-radius:20px;padding:20px 24px">
      <div style="font-size:13px;font-weight:900;letter-spacing:2px;color:#F472B6;text-transform:uppercase;display:flex;align-items:center;gap:8px"><i class="ph-fill ph-lightning"></i>Biggest mover</div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px"><span style="font-size:24px;font-weight:700;color:#fff">${mover ? esc(mover.name) : '—'}</span><span style="font-family:var(--font-mono);font-size:26px;font-weight:700;color:#4ADE80">${mover ? (mover.d >= 0 ? '+' : '') + mover.d : ''}</span></div>
    </div>
    <div style="flex:1;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:20px 24px;min-height:0;display:flex;flex-direction:column">
      <div style="font-size:13px;font-weight:900;letter-spacing:2px;color:rgba(255,255,255,.5);text-transform:uppercase;margin-bottom:14px">Latest results</div>
      <div style="display:flex;flex-direction:column;gap:12px;overflow:hidden">${ticker}</div>
    </div>
  </div>`;
}

// realtime + polling fallback
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(console.error), 300);
}

function setPolling(on) {
  clearInterval(pollTimer);
  pollTimer = on ? setInterval(() => refresh().catch(console.error), 10000) : null;
}

(async function init() {
  try {
    await refresh();
  } catch (err) {
    document.getElementById('wall-body').innerHTML =
      `<div style="color:rgba(255,255,255,.6);font-size:18px;font-weight:300">Couldn't reach the server: ${esc(err.message || err)}</div>`;
    console.error(err);
  }
  api.subscribeToChanges(scheduleRefresh, status => {
    realtimeUp = status === 'SUBSCRIBED';
    setPolling(!realtimeUp);          // poll every ~10s until realtime is back
    if (realtimeUp) scheduleRefresh(); // full refetch on (re)connect
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRefresh(); // refetch on screen wake
  });
  // keep relative timestamps fresh
  setInterval(() => { if (season) draw(); }, 60000);
})();
