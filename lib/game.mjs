// Game state, events, chat, score and history. Everything is stored as JSON files in the data folder.
// Players: 'player' (the human, White) and 'ai' (any agent, Black). Colors in the API: 'w' and 'b'.
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { analyzeMove } from './tactics.mjs';
import { detectOpening, isBook } from './openings.mjs';
import { classify, CLASSES, toCp, winChance } from '../public/js/review.js';

export const REASONS = {
  checkmate: 'checkmate', resign: 'resignation', stalemate: 'stalemate', repetition: 'threefold repetition',
  insufficient: 'insufficient material', fifty: 'fifty-move rule', agreement: 'mutual agreement',
};
export const HINT_LEVELS = { 1: 'Piece', 2: 'Move', 3: 'Why' };

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

/** Accepts UCI (e7e8n) or SAN (Nf3, exd5, e8=Q, O-O). */
export function parseMove(input) {
  const s = String(input ?? '').trim().replace(/[!?#+]+$/g, '');
  const uci = s.match(/^([a-h][1-8])([a-h][1-8])([qrbnQRBN])?$/);
  if (uci) return { from: uci[1], to: uci[2], ...(uci[3] ? { promotion: uci[3].toLowerCase() } : {}) };
  return s.replace(/^0-0-0$/, 'O-O-O').replace(/^0-0$/, 'O-O');
}

export function tryMove(chess, input) {
  const mv = parseMove(input);
  try { return chess.move(mv); } catch {}
  // UCI promotion without the piece: assume a queen
  if (typeof mv === 'object' && !mv.promotion) { try { return chess.move({ ...mv, promotion: 'q' }); } catch {} }
  return null;
}

export function sanOf(fen, uci) {
  if (!uci) return null;
  const m = tryMove(new Chess(fen), uci);
  return m ? m.san : null;
}

export class Store {
  constructor(dir) {
    this.files = {
      game: path.join(dir, 'game.json'), chat: path.join(dir, 'chat.json'),
      events: path.join(dir, 'events.json'), history: path.join(dir, 'history.json'),
    };
    const g = readJson(this.files.game, {});
    this.game = {
      id: g.id ?? 1, startedAt: g.startedAt ?? Date.now(), moves: g.moves ?? [], result: g.result ?? null,
      drawOffer: g.drawOffer ?? null, evals: g.evals ?? [], hints: g.hints ?? [], assists: g.assists ?? [],
    };
    this.chat = readJson(this.files.chat, []);
    this.events = readJson(this.files.events, []);
    this.history = readJson(this.files.history, { score: { player: 0, ai: 0, draws: 0 }, games: [] });
    this.version = 1;
    this.waiters = new Set();        // clients waiting for new events
    this.changeWaiters = new Set();  // clients waiting for the state to change (/api/state long-poll)
    // Event sequence number: always above any id already stored. (Older builds let the chat id
    // overwrite the event id, which made watchers miss moves.)
    this.seq = this.events.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
    this.motifs = [];
    this.engineReady = () => false;
    this.onChange = () => {};
    this.#rebuild();
    this.#checkEnd();
  }

  // ---------- position ----------
  #rebuild() {
    const c = new Chess();
    this.fens = [c.fen()];
    this.legal = [c.moves().length];
    const ok = [];
    for (const u of this.game.moves) {
      const m = tryMove(c, u);
      if (!m) break; // corrupted move: cut the rest
      ok.push(m.from + m.to + (m.promotion || ''));
      this.fens.push(c.fen());
      this.legal.push(c.moves().length);
    }
    this.game.moves = ok;
    this.pos = c;
    this.sans = c.history();
    this.motifs.length = Math.min(this.motifs.length, ok.length);
    let b = 0;
    while (b < ok.length && b < 30 && isBook(this.fens[b + 1])) b++;
    this.bookUntil = b; // moves [0, b) are book theory
  }

  get id() { return this.game.id; }
  get ply() { return this.game.moves.length; }
  get fen() { return this.pos.fen(); }
  get turn() { return this.pos.turn(); }
  get over() { return !!this.game.result; }

  touch() {
    this.version++;
    this.stateCache = null;
    for (const w of this.changeWaiters) w();
    this.onChange();
  }

  /** Resolves when the state version is no longer v (or after ms). */
  waitChange(v, ms) {
    if (this.version !== v || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.changeWaiters.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      this.changeWaiters.add(done);
    });
  }

  save() { writeJson(this.files.game, this.game); }

  motifsAt(i) {
    if (!this.motifs[i]) this.motifs[i] = analyzeMove(this.fens[i], this.game.moves[i]) || { motifs: [], sacrifice: false };
    return this.motifs[i];
  }

  /** Annotation of the move at index i (0 = White's first move). */
  note(i) {
    const g = this.game, uci = g.moves[i];
    if (!uci) return null;
    const a = this.motifsAt(i);
    const before = g.evals[i], after = g.evals[i + 1];
    const mover = i % 2 === 0 ? 'w' : 'b';
    const cls = classify({ before, after, mover, uci, legalCount: this.legal[i], book: i < this.bookUntil, sacrifice: a.sacrifice });
    const s = mover === 'w' ? 1 : -1;
    const loss = before && after ? Math.max(0, winChance(s * toCp(before)) - winChance(s * toCp(after))) : null;
    const hint = g.hints.find((h) => h.ply === i);
    const assist = g.assists.find((h) => h.ply === i);
    return {
      cls, label: cls ? CLASSES[cls].label : null,
      loss: loss === null ? null : Math.round(loss * 100) / 100,
      best: before?.best && before.best !== uci ? sanOf(this.fens[i], before.best) : null,
      motifs: a.motifs.slice(0, 3).map(({ type, text, arrows, marks, bad }) => ({ type, text, arrows, marks, bad: !!bad })),
      hint: hint ? (hint.uci === uci ? 'followed' : 'asked') : null,
      engine: assist ? (assist.uci === uci ? 'followed' : 'asked') : null,
    };
  }

  opening() { return detectOpening(this.fens.slice(1)); }

  pgn() {
    const c = new Chess();
    const d = new Date(this.game.startedAt);
    c.header('Event', 'Player vs AI', 'Site', 'localhost', 'Date', `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`,
      'White', 'Player', 'Black', 'AI', 'Result', this.resultTag());
    for (const u of this.game.moves) tryMove(c, u);
    return c.pgn();
  }

  resultTag() {
    const r = this.game.result;
    if (!r) return '*';
    return r.winner === 'w' ? '1-0' : r.winner === 'b' ? '0-1' : '1/2-1/2';
  }

  material() {
    const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
    const taken = { w: [], b: [] }; // pieces each side captured
    for (const m of this.pos.history({ verbose: true })) if (m.captured) taken[m.color].push(m.captured);
    const sum = (xs) => xs.reduce((n, t) => n + VAL[t], 0);
    return { byWhite: taken.w, byBlack: taken.b, diff: sum(taken.w) - sum(taken.b) };
  }

  state() {
    if (this.stateCache) return this.stateCache;
    const g = this.game;
    const r = g.result;
    this.stateCache = {
      v: this.version, id: g.id, fen: this.fen, turn: this.turn, inCheck: this.pos.inCheck(), ply: this.ply,
      status: r ? 'over' : 'playing',
      result: r ? { ...r, text: resultText(r) } : null,
      moves: this.sans, uci: g.moves, fens: this.fens,
      evals: this.fens.map((_, i) => g.evals[i] ? { cp: g.evals[i].cp, mate: g.evals[i].mate, depth: g.evals[i].depth } : null),
      notes: g.moves.map((_, i) => this.note(i)),
      hints: { count: g.hints.length, list: g.hints.map((h) => ({ ply: h.ply, level: h.level, san: h.san })) },
      assists: { count: g.assists.length },
      opening: this.opening(), drawOffer: g.drawOffer,
      material: this.material(), score: this.history.score,
      engine: { ready: this.engineReady() }, pgn: this.pgn(),
    };
    return this.stateCache;
  }

  // ---------- actions ----------
  move(input, by) {
    if (this.over) throw new HttpError(409, 'The game is already over.');
    const turn = this.turn;
    if (by && by !== turn) throw new HttpError(409, turn === 'w' ? "It's White's turn." : "It's Black's turn.");
    const probe = new Chess(this.fen);
    const m = tryMove(probe, input);
    if (!m) throw new HttpError(400, `Illegal move: ${input}`, { legal: probe.moves() });
    const uci = m.from + m.to + (m.promotion || '');
    this.game.moves.push(uci);
    this.game.drawOffer = null;
    this.#rebuild();
    this.save();
    this.emit('move', turn, { san: m.san, uci, ply: this.ply });
    this.#checkEnd();
    this.touch();
    return m;
  }

  #checkEnd() {
    if (this.game.result) return;
    const c = this.pos;
    if (c.isCheckmate()) this.#finish({ winner: c.turn() === 'w' ? 'b' : 'w', reason: 'checkmate' });
    else if (c.isStalemate()) this.#finish({ winner: null, reason: 'stalemate' });
    else if (c.isInsufficientMaterial()) this.#finish({ winner: null, reason: 'insufficient' });
    else if (c.isThreefoldRepetition()) this.#finish({ winner: null, reason: 'repetition' });
    else if (c.isDraw()) this.#finish({ winner: null, reason: 'fifty' });
  }

  #finish(r) {
    const g = this.game;
    g.result = { ...r, at: Date.now(), plies: this.ply };
    g.drawOffer = null;
    const sc = this.history.score;
    if (r.winner === 'w') sc.player++; else if (r.winner === 'b') sc.ai++; else sc.draws++;
    this.history.games.unshift({
      id: g.id, endedAt: Date.now(), winner: r.winner, reason: r.reason, plies: this.ply,
      opening: this.opening()?.name ?? null, hints: g.hints.length, assists: g.assists.length, pgn: this.pgn(),
    });
    this.history.games.length = Math.min(this.history.games.length, 60);
    writeJson(this.files.history, this.history);
    this.save();
    this.emit('end', r.winner, { winner: r.winner, reason: r.reason, text: resultText(r), score: { ...sc } });
  }

  resign(by) {
    if (this.over) throw new HttpError(409, 'The game is already over.');
    if (by !== 'w' && by !== 'b') throw new HttpError(400, 'Say who resigns (w or b).');
    this.emit('resign', by, {});
    this.#finish({ winner: by === 'w' ? 'b' : 'w', reason: 'resign', by });
    this.touch();
  }

  draw(by, action) {
    if (this.over) throw new HttpError(409, 'The game is already over.');
    if (by !== 'w' && by !== 'b') throw new HttpError(400, 'Say which side (w or b).');
    const other = by === 'w' ? 'b' : 'w';
    const g = this.game;
    if (action === 'offer' || action === 'accept') {
      if (g.drawOffer === other) {
        this.emit('draw', by, { action: 'accepted' });
        this.#finish({ winner: null, reason: 'agreement' });
      } else if (action === 'accept') {
        throw new HttpError(409, 'There is no draw offer to accept.');
      } else {
        g.drawOffer = by;
        this.save();
        this.emit('draw', by, { action: 'offered' });
      }
    } else if (action === 'decline') {
      if (g.drawOffer !== other) throw new HttpError(409, 'There is no draw offer to decline.');
      g.drawOffer = null;
      this.save();
      this.emit('draw', by, { action: 'declined' });
    } else throw new HttpError(400, 'Invalid draw action (offer, accept or decline).');
    this.touch();
  }

  reset() {
    const g = this.game;
    if (g.moves.length && !g.result) {
      this.history.games.unshift({ id: g.id, endedAt: Date.now(), winner: null, reason: 'abandoned', plies: g.moves.length, opening: this.opening()?.name ?? null, hints: g.hints.length, assists: g.assists.length, pgn: this.pgn() });
      this.history.games.length = Math.min(this.history.games.length, 60);
      writeJson(this.files.history, this.history);
    }
    this.game = { id: g.id + 1, startedAt: Date.now(), moves: [], result: null, drawOffer: null, evals: [], hints: [], assists: [] };
    this.motifs = [];
    this.#rebuild();
    this.save();
    this.emit('new_game', null, { game: this.game.id, score: { ...this.history.score } });
    this.touch();
  }

  // ---------- engine ----------
  /** Next position without an evaluation (most recent first). */
  nextMissingEval() {
    for (let i = this.fens.length - 1; i >= 0; i--) if (!this.game.evals[i]) return { id: this.id, i, fen: this.fens[i] };
    return null;
  }

  setEval(id, i, fen, ev) {
    if (id !== this.id || this.fens[i] !== fen) return false;
    const old = this.game.evals[i];
    if (old && old.depth > ev.depth) return false;
    this.game.evals[i] = ev;
    this.save();
    this.touch();
    return true;
  }

  hintAt(ply) { return this.game.hints.find((h) => h.ply === ply) || null; }

  recordHint(ply, level, uci) {
    const san = sanOf(this.fens[ply], uci);
    let h = this.hintAt(ply);
    if (h && level <= h.level) return h;
    const upgrade = !!h;
    if (h) h.level = level;
    else { h = { ply, level, uci, san, at: Date.now() }; this.game.hints.push(h); }
    this.save();
    this.emit('hint', 'w', { level: HINT_LEVELS[level], levelNumber: level, san, ply, total: this.game.hints.length, upgrade });
    this.touch();
    return h;
  }

  recordAssist(ply, uci, depth) {
    const old = this.game.assists.find((a) => a.ply === ply);
    if (old) Object.assign(old, { uci, depth });
    else this.game.assists.push({ ply, uci, depth, at: Date.now() });
    this.save();
    this.touch();
  }

  // ---------- chat and events ----------
  addChat(from, text) {
    const t = String(text ?? '').trim().slice(0, 300);
    if (!['player', 'ai'].includes(from) || !t) throw new HttpError(400, 'Invalid message.');
    const msg = { id: (this.chat.at(-1)?.id ?? 0) + 1, from, text: t, at: Date.now() };
    this.chat.push(msg);
    if (this.chat.length > 300) this.chat.splice(0, this.chat.length - 300);
    writeJson(this.files.chat, this.chat);
    this.emit('chat', from === 'player' ? 'w' : 'b', { text: t, message: msg.id });
    return msg;
  }

  emit(type, by, data) {
    // Fixed fields come AFTER the data: nothing in `data` may overwrite the event id.
    const ev = { ...data, id: ++this.seq, at: Date.now(), game: this.game.id, type, by };
    this.events.push(ev);
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    writeJson(this.files.events, this.events);
    for (const w of this.waiters) w();
    return ev;
  }

  eventsSince(id) { return this.events.filter((e) => e.id > id); }

  waitEvents(since, ms) {
    const ready = this.eventsSince(since);
    if (ready.length || ms <= 0) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(this.eventsSince(since)); };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
}

export function resultText(r) {
  const who = r.winner === 'w' ? 'Player wins' : r.winner === 'b' ? 'AI wins' : 'Draw';
  return `${who} by ${REASONS[r.reason] || r.reason}`;
}
