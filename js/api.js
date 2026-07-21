// EF Pong — data layer. The ten operations from the spec, over Supabase.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const PALETTE = [
  ['#006BD6', '#fff'], ['#DA2381', '#fff'], ['#008928', '#fff'], ['#FAB005', '#191919'],
  ['#D1334A', '#fff'], ['#191919', '#fff'], ['#0369A1', '#fff'], ['#C2410C', '#fff'],
];

export function textColorFor(hex) {
  const found = PALETTE.find(([bg]) => bg.toLowerCase() === (hex || '').toLowerCase());
  if (found) return found[1];
  const n = parseInt((hex || '#888').slice(1), 16);
  const lum = 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255);
  return lum > 160 ? '#191919' : '#fff';
}

export function mkInitials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function slugify(name) {
  return name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'player';
}

export async function getActiveSeason() {
  const { data, error } = await supabase.from('season').select('*').eq('is_active', true).single();
  if (error) throw error;
  return data;
}

// Roster with this season's numbers. Players without a standings row yet
// (self-registered, no matches) default to 1000 / 0-0.
export async function getLeaderboard(seasonId) {
  const { data, error } = await supabase
    .from('player')
    .select('id, name, initials, avatar_color, join_date, email, is_admin, standings(elo, wins, losses, peak)')
    .eq('standings.season_id', seasonId);
  if (error) throw error;
  return data
    .map(p => {
      const s = p.standings[0] || { elo: 1000, wins: 0, losses: 0, peak: 1000 };
      return {
        id: p.id, name: p.name, initials: p.initials,
        color: p.avatar_color, textColor: textColorFor(p.avatar_color),
        email: p.email || null, isAdmin: !!p.is_admin,
        elo: s.elo, wins: s.wins, losses: s.losses, peak: s.peak,
      };
    })
    .sort((a, b) => b.elo - a.elo || a.name.localeCompare(b.name));
}

// includeVoided: the app shows voided matches (dimmed, with a banner); the wall
// keeps them out of its ticker. Disputed matches are never voided, so they show
// regardless.
export async function getFeed(seasonId, limit = 30, { includeVoided = false } = {}) {
  let q = supabase
    .from('match')
    .select(`id, winner_id, loser_id, winner_score, loser_score, elo_delta, played_at,
      status, is_voided, dispute_reason, disputed_by,
      winner:player!match_winner_id_fkey(id, name, initials, avatar_color),
      loser:player!match_loser_id_fkey(id, name, initials, avatar_color),
      reaction(type),
      comment(id, text, posted_at, author:player(id, name, initials, avatar_color)),
      rating_history(player_id, rating_after, kind)`)
    .eq('season_id', seasonId);
  if (!includeVoided) q = q.eq('is_voided', false);
  const { data, error } = await q
    .order('played_at', { ascending: false })
    .order('posted_at', { referencedTable: 'comment', ascending: true })
    .limit(limit);
  if (error) throw error;
  return data.map(m => {
    // pre-match ratings from the audit trail -> upset detection, same rule as the prototype
    const wAfter = m.rating_history.find(h => h.player_id === m.winner.id && h.kind === 'match');
    const lAfter = m.rating_history.find(h => h.player_id === m.loser.id && h.kind === 'match');
    const upset = wAfter && lAfter
      ? ((lAfter.rating_after + m.elo_delta) - (wAfter.rating_after - m.elo_delta)) >= 150
      : false;
    const counts = { fire: 0, wow: 0, gg: 0, lol: 0, angry: 0, rage: 0, poop: 0 };
    m.reaction.forEach(r => { counts[r.type] = (counts[r.type] || 0) + 1; });
    return {
      id: m.id, winnerId: m.winner_id, loserId: m.loser_id,
      winnerScore: m.winner_score, loserScore: m.loser_score,
      delta: m.elo_delta, playedAt: m.played_at, upset,
      status: m.status || 'confirmed', isVoided: !!m.is_voided,
      disputeReason: m.dispute_reason, disputedBy: m.disputed_by,
      winner: m.winner, loser: m.loser, reactions: counts,
      comments: m.comment.map(c => ({ id: c.id, text: c.text, author: c.author })),
    };
  });
}

export async function getPlayerDetail(playerId, seasonId) {
  const [standing, history, matches] = await Promise.all([
    supabase.from('standings').select('elo, wins, losses, peak')
      .eq('player_id', playerId).eq('season_id', seasonId).maybeSingle(),
    supabase.from('rating_history').select('rating_after, recorded_at, match_id')
      .eq('player_id', playerId).order('recorded_at', { ascending: true }),
    supabase.from('match')
      .select(`id, winner_id, loser_id, winner_score, loser_score, elo_delta, played_at,
        winner:player!match_winner_id_fkey(id, name),
        loser:player!match_loser_id_fkey(id, name)`)
      .eq('season_id', seasonId).eq('is_voided', false)
      .or(`winner_id.eq.${playerId},loser_id.eq.${playerId}`)
      .order('played_at', { ascending: false }),
  ]);
  for (const r of [standing, history, matches]) if (r.error) throw r.error;
  return {
    standing: standing.data || { elo: 1000, wins: 0, losses: 0, peak: 1000 },
    history: history.data,
    matches: matches.data,
  };
}

// The signed-in user's own matches (winner/loser ids + when), most-recent first.
// Drives the log-a-match opponent picker: recent opponents and "n games together".
export async function getPlayerMatches(playerId, seasonId) {
  const { data, error } = await supabase.from('match')
    .select('winner_id, loser_id, played_at')
    .eq('season_id', seasonId).eq('is_voided', false)
    .or(`winner_id.eq.${playerId},loser_id.eq.${playerId}`)
    .order('played_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function logMatch({ winnerId, loserId, winnerScore, loserScore, enteredBy }) {
  const { data, error } = await supabase.rpc('log_match', {
    p_winner_id: winnerId, p_loser_id: loserId,
    p_winner_score: winnerScore, p_loser_score: loserScore,
    p_entered_by: enteredBy ?? null,
  });
  if (error) throw error;
  return data;
}

export async function addPlayer(name, rosterSize) {
  const [color] = PALETTE[rosterSize % PALETTE.length];
  const row = {
    id: slugify(name), name: name.trim(), initials: mkInitials(name),
    avatar_color: color,
  };
  let { data, error } = await supabase.from('player').insert(row).select().single();
  if (error && error.code === '23505' && error.message.includes('player_pkey')) {
    row.id = `${row.id}-${Math.random().toString(36).slice(2, 6)}`;
    ({ data, error } = await supabase.from('player').insert(row).select().single());
  }
  if (error) throw error;
  return data;
}

export async function addReaction(matchId, type) {
  const { error } = await supabase.from('reaction').insert({ match_id: matchId, type });
  if (error) throw error;
}

export async function postComment(matchId, authorId, text) {
  const { error } = await supabase.from('comment')
    .insert({ match_id: matchId, author_id: authorId, text });
  if (error) throw error;
}

export async function deleteComment(commentId) {
  const { error } = await supabase.from('comment').delete().eq('id', commentId);
  if (error) throw error;
}

// ---------- auth (magic link) ----------
export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

export function onAuthChange(cb) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return data.subscription;
}

// OAuth sign-in (google / azure / …). Redirects the browser to the provider
// and back; onAuthChange picks up the established session on return.
export async function signInWithProvider(provider) {
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: window.location.origin + window.location.pathname,
      scopes: provider === 'azure' ? 'openid profile email' : undefined,
    },
  });
  if (error) throw error;
}

export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// email -> the roster player it's bound to (recognised sign-in), or null
export async function resolvePlayerByEmail(email) {
  const { data, error } = await supabase.from('player')
    .select('id, name, initials, avatar_color, email, is_admin')
    .ilike('email', email.trim()).maybeSingle();
  if (error) throw error;
  return data;
}

// ---------- claims (sign-ins awaiting admin approval) ----------
export async function getMyClaim(email) {
  const { data, error } = await supabase.from('claim')
    .select('id, player_id, email').ilike('email', email.trim())
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

export async function listClaims() {
  const { data, error } = await supabase.from('claim')
    .select('id, player_id, email, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function createClaim(playerId, email) {
  // don't stack duplicate claims for the same person
  const { data: existing } = await supabase.from('claim')
    .select('id').eq('player_id', playerId).limit(1);
  if (existing && existing.length) return existing[0];
  const { data, error } = await supabase.from('claim')
    .insert({ player_id: playerId, email: email.trim() }).select().single();
  if (error) throw error;
  return data;
}

export async function approveClaim(claimId) {
  const { error } = await supabase.rpc('approve_claim', { p_claim_id: claimId });
  if (error) throw error;
}

export async function rejectClaim(claimId) {
  const { error } = await supabase.rpc('reject_claim', { p_claim_id: claimId });
  if (error) throw error;
}

// ---------- disputes ----------
export async function disputeMatch(matchId, reason) {
  const { error } = await supabase.rpc('dispute_match', { p_match_id: matchId, p_reason: reason });
  if (error) throw error;
}

export async function withdrawDispute(matchId) {
  const { error } = await supabase.rpc('withdraw_dispute', { p_match_id: matchId });
  if (error) throw error;
}

// action: 'uphold' | 'void' | 'void_penalize'
export async function resolveDispute(matchId, action, penalty = 50) {
  const { data, error } = await supabase.rpc('resolve_dispute', {
    p_match_id: matchId, p_action: action, p_penalty: penalty,
  });
  if (error) throw error;
  return data;
}

// void / penalty events for a player -> "your ELO changed" feed notes
export async function getRatingEvents(playerId) {
  const { data, error } = await supabase.from('rating_history')
    .select('id, match_id, rating_after, kind, recorded_at')
    .eq('player_id', playerId).in('kind', ['void', 'penalty'])
    .order('recorded_at', { ascending: false }).limit(20);
  if (error) throw error;
  return data;
}

// ---------- rollout flag ----------
export async function getRolloutComplete() {
  const { data, error } = await supabase.rpc('rollout_complete');
  if (error) throw error;
  return !!data;
}

export async function setRolloutComplete(on) {
  const { error } = await supabase.rpc('set_rollout_complete', { p_on: on });
  if (error) throw error;
}

// Live wall / app freshness: subscribe to the four hot tables; onChange fires
// on any insert/update/delete so callers can refetch their views.
export function subscribeToChanges(onChange, onStatus) {
  const channel = supabase.channel('efpong-live');
  for (const table of ['match', 'standings', 'reaction', 'comment', 'claim']) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange);
  }
  channel.subscribe(status => onStatus && onStatus(status));
  return channel;
}
