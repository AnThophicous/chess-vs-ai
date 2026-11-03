// Game server: you (White, the player) against an AI (Black, any agent).
// Validates moves, stores everything as JSON, runs Stockfish in Node (two instances: one for the
// player's hints and the evaluation bar, one for the AI's "mini-Stockfish" advisor), and holds
// /api/state as a long-poll so the AI's watcher knows the moment the player moves.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { Store, HttpError, HINT_LEVELS, parseMove } from './lib/game.mjs';
import { Engine } from './lib/engine.mjs';
import { analyzeMove, threatsFor, passTurn, explain } from './lib/tactics.mjs';
import { boardPng, ARROW } from './lib/render.mjs';
import { evalLabel } from './public/js/review.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;
const PORT = Number(process.env.PORT || 8765);

const store = new Store(DATA);
const playerEngine = new Engine('player');
const aiEngine = new Engine('ai');
store.engineReady = () => playerEngine.ready;
playerEngine.onReady = () => store.touch(); // the hint button leaves "Loading engine…"
store.onChange = () => queueMicrotask(evalLoop);

// ---------- background evaluations (eval bar + move classification) ----------
// Scores here are ALWAYS from White's point of view (positive = White better).
function whiteEval(fen, res) {
  const s = fen.split(' ')[1] === 'w' ? 1 : -1;
  const l = res.lines[0];
  if (!l) return null;
  if (l.mate !== undefined) return { mate: s * l.mate, cp: s * l.mate > 0 ? 2000 : -2000, best: res.best, depth: l.depth };
  return { cp: s * l.cp, best: res.best, depth: l.depth };
}
function terminalEval(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { mate: 0, cp: c.turn() === 'w' ? -2000 : 2000, best: null, depth: 99 };
  if (c.isDraw() || c.isStalemate()) return { cp: 0, best: null, depth: 99 };
  return null;
}

/**
 * Priority evaluation of the two positions that classify the player's move: the new one and,
 * if still missing, the one before it. Does not block the HTTP response. Ready in ~2-3 s.
 */
async function evalNow(id, ply) {
  try {
    for (const i of [ply, ply - 1]) {
      if (i < 0 || store.id !== id || store.game.evals[i]) continue;
      const fen = store.fens[i];
      const ev = terminalEval(fen) || whiteEval(fen, await playerEngine.search(fen, { movetime: 1500, priority: 10 }));
      if (ev) store.setEval(id, i, fen, ev); // setEval ignores the result if the game changed
    }
  } catch (err) {
    console.error('[evaluation now]', err);
  }
}

let evalBusy = false;
async function evalLoop() {
  if (evalBusy) return;
  evalBusy = true;
  try {
    for (let guard = 0; guard < 400; guard++) {
      const job = store.nextMissingEval();
      if (!job) break;
      const term = terminalEval(job.fen);
      if (term) { store.setEval(job.id, job.i, job.fen, term); continue; }
      const res = await playerEngine.search(job.fen, { depth: 14, movetime: 4000, priority: 0 });
      const ev = whiteEval(job.fen, res);
      // Cut short by a hint? Try again later.
      if (!ev || ev.depth < 9) { await new Promise((r) => setTimeout(r, 400)); continue; }
      store.setEval(job.id, job.i, job.fen, ev);
    }
  } catch (err) {
    console.error('[evaluation]', err);
  } finally {
    evalBusy = false;
  }
}

// ---------- player's hint ----------
async function hint(level) {
  level = Math.min(3, Math.max(1, Number(level) || 2));
  if (store.over) throw new HttpError(409, 'The game is already over.');
  if (store.turn !== 'w') throw new HttpError(409, "It's not your turn yet.");
  const { id, ply, fen } = store;
  let h = store.hintAt(ply);
  let depth = null;
  if (!h) {
    const res = await playerEngine.search(fen, { movetime: 2500, priority: 10 });
    if (!res.best) throw new HttpError(503, 'The engine has no move right now. Try again.');
    if (store.id !== id || store.ply !== ply) throw new HttpError(409, 'The position changed while the engine was thinking.');
    const ev = whiteEval(fen, res);
    if (ev) store.setEval(id, ply, fen, ev);
    depth = res.depth;
    h = { uci: res.best };
  }
  const rec = store.recordHint(ply, level, h.uci);
  const a = analyzeMove(fen, parseMove(rec.uci));
  return {
    ply, level, levelName: HINT_LEVELS[level], uci: rec.uci, san: a.san, from: a.from, to: a.to, piece: a.piece,
    motifs: a.motifs.map(({ type, text, arrows, marks, bad }) => ({ type, text, arrows, marks, bad: !!bad })),
    why: explain(fen, a), depth, total: store.game.hints.length,
  };
}

// ---------- AI advisor (mini-Stockfish) ----------
function pvSan(fen, pv) {
  const c = new Chess(fen);
  const out = [];
  for (const u of pv) {
    let m = null;
    try { m = c.move(parseMove(u)); } catch {}
    if (!m) break;
    out.push(m.san);
  }
  return out;
}
// Converts a White-POV evaluation to the POV of the side to move.
const moverEval = (ev, side) => (ev ? evalLabel(side === 'w' ? ev : { ...ev, cp: -ev.cp, mate: ev.mate === undefined ? undefined : -ev.mate }) : '…');

async function analysis({ depth = 12, lines = 3, by = null } = {}) {
  depth = Math.min(20, Math.max(6, Number(depth) || 12));
  lines = Math.min(5, Math.max(1, Number(lines) || 3));
  const { id, ply, fen, turn } = store;
  const st = store.state();
  if (store.over) return { ended: true, result: st.result.text, score: st.score };
  const res = await aiEngine.search(fen, { depth, multipv: lines, movetime: 15000, priority: 5 });
  if (store.id !== id || store.ply !== ply) throw new HttpError(409, 'The position changed during the analysis. Ask again.');
  const s = turn === 'w' ? 1 : -1;
  const best = res.lines.map((l, k) => {
    const a = analyzeMove(fen, parseMove(l.pv[0]));
    // Both fields are shown so nobody has to guess the sign:
    //   evalWhite   : White's point of view (positive = White better)
    //   evalForMover: point of view of the side to move
    const evW = l.mate !== undefined ? { mate: s * l.mate, cp: s * l.mate > 0 ? 2000 : -2000 } : { cp: s * l.cp };
    return {
      rank: k + 1, uci: l.pv[0], san: a?.san ?? l.pv[0],
      evalWhite: evalLabel(evW), evalForMover: moverEval(evW, turn), depth: l.depth,
      line: pvSan(fen, l.pv.slice(0, 8)).join(' '),
      tactics: a ? a.motifs.slice(0, 3).map((m) => m.text) : [],
    };
  });

  const threats = threatsFor(fen).slice(0, 5).map((t) => t.text);
  let threat = null;
  if (!store.pos.inCheck()) {
    const passed = passTurn(fen);
    if (passed && !passed.isGameOver()) {
      const r2 = await aiEngine.search(passed.fen(), { depth: 10, priority: 5 });
      if (r2.best) {
        const a2 = analyzeMove(passed.fen(), parseMove(r2.best));
        threat = { move: a2?.san ?? r2.best, tactics: a2 ? a2.motifs.slice(0, 2).map((m) => m.text) : [] };
      }
    }
  }

  const last = ply > 0 ? store.note(ply - 1) : null;
  if (by === 'ai' && res.best) store.recordAssist(ply, res.best, depth);
  return {
    fen, toMove: turn === 'w' ? 'white' : 'black', moveNumber: Math.floor(ply / 2) + 1,
    opening: st.opening?.name ?? null,
    evalWhite: best[0]?.evalWhite ?? '…', evalForMover: best[0]?.evalForMover ?? '…',
    bestMoves: best,
    threatsAgainstMover: threats,
    ifMoverPassed: threat,
    lastOpponentMove: last && {
      san: st.moves[ply - 1], label: last.label ?? 'calculating…', lossOfChances: last.loss,
      bestWas: last.best, tactics: last.motifs.map((m) => m.text),
      followedHint: last.hint === 'followed', askedHint: !!last.hint,
    },
    material: st.material,
    hintsByPlayer: st.hints.count,
    engineConsultsByAI: store.game.assists.length,
  };
}

// ---------- board photo ----------
function boardImage(q) {
  const st = store.state();
  const ply = q.has('ply') ? Math.min(st.ply, Math.max(0, Number(q.get('ply')) || 0)) : st.ply;
  const fen = st.fens[ply];
  const lastUci = ply > 0 ? st.uci[ply - 1] : null;
  const note = ply > 0 ? st.notes[ply - 1] : null;
  const arrows = [];
  const marks = [];
  if (q.get('motifs') !== '0' && note?.motifs?.[0]) {
    for (const [from, to] of note.motifs[0].arrows) arrows.push({ from, to, color: note.motifs[0].bad ? ARROW.threat : ARROW.motif });
    marks.push(...note.motifs[0].marks);
  }
  for (const spec of (q.get('arrows') || '').split(',').filter(Boolean)) {
    const [u, kind] = spec.split(':');
    if (/^[a-h][1-8][a-h][1-8]/.test(u)) arrows.push({ from: u.slice(0, 2), to: u.slice(2, 4), color: ARROW[kind] || ARROW.best });
  }
  const turn = fen.split(' ')[1];
  const moveNo = Math.floor(ply / 2) + 1;
  const lastTxt = lastUci ? ` · last: ${st.moves[ply - 1]}${note?.label ? ` (${note.label})` : ''}` : '';
  const caption = st.status === 'over' && ply === st.ply ? `${st.result.text}${lastTxt}` : `Move ${moveNo} · ${turn === 'w' ? 'White' : 'Black'} to move${lastTxt}`;
  return boardPng({
    fen, orient: q.get('orient') === 'b' ? 'b' : 'w',
    last: lastUci ? { from: lastUci.slice(0, 2), to: lastUci.slice(2, 4) } : null,
    arrows, marks, badge: note?.cls ?? null, caption, evalText: evalLabel(st.evals[ply]),
  });
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 65536) { reject(new HttpError(413, 'Body too large.')); req.destroy(); } });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

// Accepts 'w' / 'b' or the words 'white' / 'black'.
const side = (v) => (v === 'w' || v === 'white' ? 'w' : v === 'b' || v === 'black' ? 'b' : null);

// During a game the AI speaks only together with its move (or resignation / draw action).
const AI_SPEAKS_WITH_MOVE = 'During a game the AI speaks only together with its move: POST /api/move {"move":"…","by":"b","text":"…"} or node play.mjs <move> "<text>".';
function aiSays(body) {
  const t = String(body.text ?? '').trim();
  if (t) store.addChat('ai', t);
}

const routes = {
  // ?v=<version>&wait=<s>: long-poll, holds the response until the state changes (the AI watcher uses it).
  'GET /api/state': async (q) => {
    const v = Number(q.get('v'));
    const wait = Math.min(30, Math.max(0, Number(q.get('wait')) || 0)) * 1000;
    if (wait) await store.waitChange(v, wait);
    const st = store.state();
    return v === st.v ? { v: st.v, same: true } : st;
  },
  'POST /api/move': async (q, body) => {
    const m = store.move(body.move ?? (body.from && body.to ? body.from + body.to + (body.promotion || '') : ''), side(body.by));
    // Player's move: evaluate the new position right away (preempts the background queue), so the
    // classification and the AI's alert come out in ~2 s instead of after the queue.
    if (m.color === 'w') evalNow(store.id, store.ply);
    else aiSays(body);
    const st = store.state();
    return { ok: true, played: m.san, motifs: st.notes.at(-1)?.motifs ?? [], ...st };
  },
  'POST /api/hint': (q, body) => hint(body.level),
  'GET /api/analysis': (q) => analysis({ depth: q.get('depth'), lines: q.get('lines'), by: q.get('by') }),
  'POST /api/resign': (q, body) => { store.resign(side(body.by)); if (side(body.by) === 'b') aiSays(body); return store.state(); },
  'POST /api/draw': (q, body) => { store.draw(side(body.by), body.action); if (side(body.by) === 'b') aiSays(body); return store.state(); },
  'POST /api/reset': () => { playerEngine.clearQueue(); store.reset(); return { ok: true, ...store.state() }; },
  'GET /api/chat': (q) => { const after = Number(q.get('after')) || 0; return after ? store.chat.filter((m) => m.id > after) : store.chat; },
  'POST /api/chat': (q, body) => {
    if (body.from === 'ai' && !store.over) throw new HttpError(409, AI_SPEAKS_WITH_MOVE);
    return store.addChat(body.from, body.text);
  },
  'GET /api/events': async (q) => {
    const since = Number(q.get('since')) || 0;
    const wait = Math.min(60, Math.max(0, Number(q.get('wait')) || 0)) * 1000;
    const events = await store.waitEvents(since, wait);
    return { last: store.events.at(-1)?.id ?? 0, events };
  },
  'GET /api/history': () => ({ score: store.history.score, games: store.history.games.map(({ pgn, ...g }) => g) }),
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/board.png') return send(res, 200, boardImage(url.searchParams), 'image/png');
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      return send(res, 200, await route(url.searchParams, body));
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Route not found.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
    const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(PUB, rel));
    if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
    console.error(err);
    return send(res, 500, { error: String(err.message || err) });
  }
}).listen(PORT, () => {
  console.log(`Chess server at http://localhost:${PORT}/ (data in ${DATA})`);
  evalLoop();
});
