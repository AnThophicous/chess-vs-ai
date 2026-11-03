// "Is it the AI's turn?" plus a summary of that turn. It is built from the game STATE, not from
// events: "is it Black's turn on a move I have not announced yet?". So nothing is lost if an event
// goes missing, the server restarts, a new game starts or the watcher restarts.
// Used by watch.mjs (Monitor tool) and mcp.mjs (wait_for_player). Talks only HTTP to the game server.

export const HINT_NAMES = { 1: 'Piece', 2: 'Move', 3: 'Why' };

/** GET JSON from the game server. */
export function makeGet(base) {
  base = base.replace(/\/$/, '');
  return async (route) => {
    const res = await fetch(base + route, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  };
}

/** Key of the AI's turn (`game:ply`), or null if it is not Black's turn. */
export const turnKey = (st) => (st && st.status === 'playing' && st.turn === 'b' ? `${st.id}:${st.ply}` : null);

/** Long-poll: the state as soon as it differs from version v, or null if nothing changed within waitS seconds. */
export async function nextState(get, v, waitS) {
  const st = await get(`/api/state?v=${v ?? ''}&wait=${Math.max(0, waitS).toFixed(1)}`);
  return st.same ? null : st;
}

/** Waits for the classification of the last move (the server evaluates in ~2 s). null if the position changed. */
async function classified(get, st, ms) {
  const deadline = Date.now() + ms;
  let s = st;
  while (s.ply > 0 && !s.notes[s.ply - 1]?.cls && Date.now() < deadline) {
    const n = await nextState(get, s.v, (deadline - Date.now()) / 1000);
    if (!n) continue;
    if (n.id !== st.id || n.ply !== st.ply) return null;
    s = n;
  }
  return s;
}

/** Player messages after the AI's last message (the ones it should answer on its next move). */
function chatSinceAi(chat) {
  let i = chat.length - 1;
  while (i >= 0 && chat[i].from !== 'ai') i--;
  return chat.slice(i + 1).filter((m) => m.from === 'player').map((m) => m.text).slice(-5);
}

/**
 * Everything the AI needs to play AND talk, in one object: the player's last move with its
 * classification, the hint they asked for, the chat since the AI's last message, and the
 * mini-Stockfish analysis (which counts as an engine consult). null if the position changed.
 */
export async function turnSummary(get, st0) {
  const [st, an, chat] = await Promise.all([
    classified(get, st0, 6500),
    get('/api/analysis?by=ai&lines=3&depth=12').catch((err) => ({ error: err.message })),
    get('/api/chat').catch(() => []),
  ]);
  if (!st) return null;
  const i = st.ply - 1;
  const n = i >= 0 ? st.notes[i] : null;
  const hint = st.hints.list.find((h) => h.ply === i);
  return {
    event: 'your_turn',
    game: st.id,
    moveNumber: Math.floor(st.ply / 2) + 1,
    playerMove: n && {
      move: st.moves[i],
      label: n.label ?? 'calculating',
      bestWas: n.best,
      tactics: n.motifs.map((m) => m.text),
      hint: hint ? HINT_NAMES[hint.level] : null,
      followedHint: n.hint === 'followed',
    },
    hintsInGame: st.hints.count,
    chat: chatSinceAi(chat),
    drawOffered: st.drawOffer === 'w',
    inCheck: st.inCheck,
    evalForMover: an.evalForMover ?? null,
    candidates: (an.bestMoves || []).map((m) => ({
      move: m.san, uci: m.uci, evalForMover: m.evalForMover, tactics: m.tactics.slice(0, 2),
      line: m.line.split(' ').slice(0, 5).join(' '),
    })),
    threats: (an.threatsAgainstMover || []).slice(0, 3),
    ifYouPassed: an.ifMoverPassed ?? null,
    materialForMover: -st.material.diff,
    opening: st.opening?.name ?? null,
    score: `player ${st.score.player} × ${st.score.ai} ai`,
    fen: st.fen,
    ...(an.error ? { analysisError: an.error } : {}),
  };
}

/** Summary of a finished game. */
export function endSummary(st) {
  return {
    event: 'end', game: st.id, result: st.result.text,
    winner: st.result.winner === 'b' ? 'ai' : st.result.winner === 'w' ? 'player' : null,
    lastMove: st.moves.at(-1) ?? null, hintsInGame: st.hints.count,
    score: `player ${st.score.player} × ${st.score.ai} ai`,
  };
}
