// Tactics detector: fork, pin, skewer, loose piece, check (discovered and double), mate and mate
// threat. Works on the position alone (no engine), so it is fast and deterministic.
import { Chess } from 'chess.js';

export const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const FILES = 'abcdefgh';
const opp = (c) => (c === 'w' ? 'b' : 'w');

const ROOK = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const QUEEN = [...ROOK, ...BISHOP];
const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const RAYS = { b: BISHOP, r: ROOK, q: QUEEN };

// Display priority: the strongest motif comes first.
const PRIORITY = {
  mate: 100, fork: 90, doubleCheck: 85, skewer: 80, mateThreat: 78, pin: 70, discoveredCheck: 68,
  freeCapture: 60, hanging: 58, threat: 50, check: 40, promotion: 35, enPassant: 30, castle: 20, capture: 10,
};

// ---------- text ----------
const the = (t) => `the ${NAME[t]}`;
const The = (t) => the(t).replace(/^./, (c) => c.toUpperCase());
const into = (t) => `into the ${NAME[t]}`;
const joinEn = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs.at(-1));
const PLURAL = { p: 'both pawns', n: 'both knights', b: 'both bishops', r: 'both rooks', q: 'both queens' };
// "the king and the rook on a8", "both rooks (a8 and e8)"
function targetList(grid, squares) {
  const byType = {};
  for (const s of squares) (byType[grid[s].type] ||= []).push(s);
  const order = ['k', 'q', 'r', 'b', 'n', 'p'].filter((t) => byType[t]);
  return joinEn(order.map((t) => {
    const sqs = byType[t];
    if (t === 'k') return 'the king';
    if (sqs.length === 2 && PLURAL[t]) return `${PLURAL[t]} (${sqs.join(' and ')})`;
    return sqs.map((s) => `${the(t)} on ${s}`).join(' and ');
  }));
}

// ---------- geometry ----------
function toGrid(chess) {
  const grid = {};
  chess.board().forEach((row, r) => row.forEach((p, f) => { if (p) grid[FILES[f] + (8 - r)] = { type: p.type, color: p.color }; }));
  return grid;
}
const coords = (sq) => [FILES.indexOf(sq[0]), Number(sq[1]) - 1];
const square = (f, r) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? FILES[f] + (r + 1) : null);

export function attacksFrom(grid, sq) {
  const p = grid[sq];
  if (!p) return [];
  const [f, r] = coords(sq);
  const out = [];
  const step = (df, dr) => { const s = square(f + df, r + dr); if (s) out.push(s); };
  if (p.type === 'p') { const d = p.color === 'w' ? 1 : -1; step(-1, d); step(1, d); }
  else if (p.type === 'n') KNIGHT.forEach(([a, b]) => step(a, b));
  else if (p.type === 'k') QUEEN.forEach(([a, b]) => step(a, b));
  else {
    for (const [df, dr] of RAYS[p.type]) {
      for (let i = 1; ; i++) {
        const s = square(f + df * i, r + dr * i);
        if (!s) break;
        out.push(s);
        if (grid[s]) break;
      }
    }
  }
  return out;
}

export function attackers(grid, target, color) {
  const out = [];
  for (const sq in grid) if (grid[sq].color === color && attacksFrom(grid, sq).includes(target)) out.push(sq);
  return out;
}

const cheapest = (grid, squares) => Math.min(...squares.map((s) => VALUE[grid[s].type]));

// Loose piece: attacked and undefended, or attacked by a cheaper piece.
export function isLoose(grid, sq) {
  const p = grid[sq];
  if (!p || p.type === 'k') return false;
  const att = attackers(grid, sq, opp(p.color));
  if (!att.length) return false;
  return attackers(grid, sq, p.color).length === 0 || cheapest(grid, att) < VALUE[p.type];
}

function kingSquare(grid, color) {
  for (const sq in grid) if (grid[sq].type === 'k' && grid[sq].color === color) return sq;
  return null;
}

// ---------- single-piece patterns ----------
function forkAt(grid, sq) {
  const p = grid[sq];
  if (!p || p.type === 'k') return null;
  const enemy = opp(p.color);
  const att = attackers(grid, sq, enemy);
  // A fork only counts if the forking piece cannot simply be captured.
  if (att.length && (!attackers(grid, sq, p.color).length || cheapest(grid, att) < VALUE[p.type])) return null;
  const targets = attacksFrom(grid, sq).filter((t) => {
    const q = grid[t];
    if (!q || q.color !== enemy) return false;
    if (q.type === 'k') return true;
    if (VALUE[q.type] < 3) return false;
    return VALUE[q.type] > VALUE[p.type] || attackers(grid, t, enemy).length === 0;
  });
  if (targets.length < 2) return null;
  return {
    type: 'fork', by: sq, targets,
    text: `Fork! The ${NAME[p.type]} on ${sq} attacks ${targetList(grid, targets)}.`,
    arrows: targets.map((t) => [sq, t]), marks: targets,
  };
}

function linesAt(grid, sq) {
  const p = grid[sq];
  if (!p || !RAYS[p.type]) return [];
  const enemy = opp(p.color);
  const [f, r] = coords(sq);
  const out = [];
  for (const [df, dr] of RAYS[p.type]) {
    let first = null, second = null;
    for (let i = 1; ; i++) {
      const s = square(f + df * i, r + dr * i);
      if (!s) break;
      if (!grid[s]) continue;
      if (!first) { first = s; if (grid[s].color !== enemy) break; continue; }
      second = s;
      break;
    }
    if (!first || !second || grid[second].color !== enemy) continue;
    const a = grid[first], b = grid[second];
    if (b.type === 'k' && a.type !== 'p') {
      out.push({
        type: 'pin', by: sq, pinned: first, behind: second, absolute: true,
        text: `Pin: the ${NAME[p.type]} on ${sq} pins the ${NAME[a.type]} on ${first} to the king.`,
        arrows: [[sq, second]], marks: [first],
      });
    } else if (a.type === 'k' && VALUE[b.type] >= 3) {
      out.push({
        type: 'skewer', by: sq, front: first, behind: second,
        text: `Skewer: the ${NAME[p.type]} on ${sq} gives check and takes the ${NAME[b.type]} on ${second}, which is behind the king.`,
        arrows: [[sq, second]], marks: [second],
      });
    } else if (b.type !== 'k' && a.type !== 'p' && VALUE[b.type] >= 5 && VALUE[b.type] > VALUE[a.type]) {
      out.push({
        type: 'pin', by: sq, pinned: first, behind: second, absolute: false,
        text: `Pin: the ${NAME[p.type]} on ${sq} pins the ${NAME[a.type]} on ${first} ${into(b.type)}.`,
        arrows: [[sq, second]], marks: [first],
      });
    } else if (a.type !== 'k' && VALUE[a.type] >= 5 && VALUE[a.type] > VALUE[b.type] && VALUE[b.type] >= 3
      && (VALUE[a.type] > VALUE[p.type] || !attackers(grid, first, enemy).length)) {
      out.push({
        type: 'skewer', by: sq, front: first, behind: second,
        text: `Skewer: the ${NAME[p.type]} on ${sq} attacks the ${NAME[a.type]} on ${first}; when it moves, the ${NAME[b.type]} on ${second} falls.`,
        arrows: [[sq, second]], marks: [first, second],
      });
    }
  }
  return out;
}

function patterns(grid, color) {
  const out = [];
  for (const sq in grid) {
    if (grid[sq].color !== color) continue;
    const fk = forkAt(grid, sq);
    if (fk) out.push(fk);
    out.push(...linesAt(grid, sq));
  }
  return out;
}
const keyOf = (m) => [m.type, m.by, ...(m.targets || []), m.pinned || m.front || '', m.behind || ''].join(':');

function safeMove(chess, move) {
  try { return chess.move(move); } catch { return null; }
}

// Same position, but the turn passed to the other side (the "null move"). null if illegal.
export function passTurn(fen) {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  try {
    const c = new Chess(parts.join(' '));
    return c;
  } catch { return null; }
}

function mateInOne(chess) {
  for (const m of chess.moves({ verbose: true })) {
    const c = new Chess(chess.fen());
    c.move(m.san);
    if (c.isCheckmate()) return m;
  }
  return null;
}

// ---------- API ----------
/**
 * Analyzes a move: what tactics it creates.
 * @returns {{san, uci, color, piece, motifs: Array, sacrifice: boolean} | null}
 */
export function analyzeMove(fen, move) {
  const pos = new Chess(fen);
  const before = toGrid(pos);
  const mover = pos.turn();
  const enemy = opp(mover);
  const m = safeMove(pos, move);
  if (!m) return null;
  const after = toGrid(pos);
  const motifs = [];

  // Checks and mate
  const enemyKing = kingSquare(after, enemy);
  if (pos.isCheckmate()) {
    const checkers = attackers(after, enemyKing, mover);
    motifs.push({ type: 'mate', text: 'Checkmate!', arrows: checkers.map((s) => [s, enemyKing]), marks: [enemyKing] });
  } else if (pos.inCheck()) {
    const checkers = attackers(after, enemyKing, mover);
    const type = checkers.length > 1 ? 'doubleCheck' : checkers[0] !== m.to ? 'discoveredCheck' : 'check';
    const text = { doubleCheck: 'Double check! Only the king can move.', discoveredCheck: 'Discovered check!', check: 'Check!' }[type];
    motifs.push({ type, text, arrows: checkers.map((s) => [s, enemyKing]), marks: [enemyKing] });
  }

  // New forks, pins and skewers (including those uncovered by another piece)
  const old = new Set(patterns(before, mover).map(keyOf));
  for (const t of patterns(after, mover)) {
    if (old.has(keyOf(t))) continue;
    if (t.by !== m.to) t.text = t.text.replace(/^(\S+)/, '$1 (discovered)');
    motifs.push(t);
  }

  // Captures
  if (m.captured) {
    const recapture = attackers(after, m.to, enemy).length > 0;
    if (!recapture) motifs.push({ type: 'freeCapture', text: `Took ${the(m.captured)} for free.`, arrows: [], marks: [m.to] });
    else if (VALUE[m.captured] > VALUE[m.piece]) motifs.push({ type: 'freeCapture', text: `Won material: the ${NAME[m.piece]} took ${the(m.captured)}.`, arrows: [], marks: [m.to] });
    else motifs.push({ type: 'capture', text: `Captures ${the(m.captured)}.`, arrows: [], marks: [m.to] });
  }

  // New attacks on loose enemy pieces
  const forked = new Set(motifs.filter((x) => x.type === 'fork').flatMap((x) => x.targets));
  for (const sq in after) {
    const p = after[sq];
    if (p.color !== enemy || VALUE[p.type] < 3 || forked.has(sq)) continue;
    if (isLoose(after, sq) && !isLoose(before, sq)) {
      const att = attackers(after, sq, mover);
      motifs.push({ type: 'threat', text: `Attacks the ${NAME[p.type]} on ${sq}.`, arrows: att.map((s) => [s, sq]), marks: [sq] });
    }
  }

  // Own pieces left hanging
  let sacrifice = false;
  for (const sq in after) {
    const p = after[sq];
    if (p.color !== mover || p.type === 'k' || VALUE[p.type] < 3) continue;
    const wasLoose = sq !== m.to && isLoose(before, sq);
    if (isLoose(after, sq) && !wasLoose) {
      const att = attackers(after, sq, enemy);
      const tradeOk = sq === m.to && m.captured && VALUE[m.captured] >= VALUE[m.piece];
      if (tradeOk) continue;
      if (sq === m.to) sacrifice = true;
      motifs.push({
        type: 'hanging', bad: true,
        text: `Careful: the ${NAME[p.type]} on ${sq} is hanging.`,
        arrows: att.map((s) => [s, sq]), marks: [sq],
      });
    }
  }

  // Mate threat (if it were their turn again)
  if (!pos.inCheck() && !pos.isGameOver()) {
    const again = passTurn(pos.fen());
    const mate = again && mateInOne(again);
    if (mate) motifs.push({ type: 'mateThreat', text: `Threatens mate with ${mate.san}.`, arrows: [[mate.from, mate.to]], marks: [] });
  }

  if (m.promotion) motifs.push({ type: 'promotion', text: `Promotes to a ${NAME[m.promotion]}.`, arrows: [], marks: [m.to] });
  if (m.flags.includes('e')) motifs.push({ type: 'enPassant', text: 'En passant!', arrows: [], marks: [m.to] });
  if (m.flags.includes('k') || m.flags.includes('q')) motifs.push({ type: 'castle', text: 'Castling: king safe and rook in play.', arrows: [], marks: [] });

  motifs.sort((a, b) => (PRIORITY[b.type] || 0) - (PRIORITY[a.type] || 0));
  return { san: m.san, uci: m.from + m.to + (m.promotion || ''), color: mover, piece: m.piece, from: m.from, to: m.to, motifs, sacrifice };
}

const CENTER = new Set(['d4', 'e4', 'd5', 'e5']);
const BIG_CENTER = new Set(['c3', 'd3', 'e3', 'f3', 'c4', 'f4', 'c5', 'f5', 'c6', 'd6', 'e6', 'f6']);

/** Reasons in English for an analyzed move (used by the hint's "Why?" step). */
export function explain(fen, a) {
  if (!a) return [];
  // List of short sentences; the UI shows one per line.
  const why = a.motifs.filter((m) => !m.bad).map((m) => m.text);
  const backRank = a.color === 'w' ? '1' : '8';
  const opening = Number(fen.split(' ')[5]) <= 12;
  if (a.piece !== 'p' && a.piece !== 'k' && a.from[1] === backRank && opening) why.push('Develops: moves a piece off the back rank so it can play.');
  if (CENTER.has(a.to)) why.push('Fights for the center, where pieces are strongest.');
  else if (BIG_CENTER.has(a.to) && a.piece !== 'k' && a.piece !== 'p') why.push('Puts the piece aiming at the center.');
  if (a.motifs.some((m) => m.bad)) why.push('Leaves a piece hanging, but the engine calculated it is worth it.');
  if (!why.length) why.push('Improves the position and prepares the next move. A positional move, no direct attack.');
  return why;
}

/**
 * What threatens the side about to move: its loose pieces, mate in 1, and forks the opponent would have.
 */
export function threatsFor(fen) {
  const pos = new Chess(fen);
  const me = pos.turn();
  const grid = toGrid(pos);
  const out = [];
  for (const sq in grid) {
    const p = grid[sq];
    if (p.color !== me || !isLoose(grid, sq)) continue;
    const att = attackers(grid, sq, opp(me));
    const by = att.map((s) => `the ${NAME[grid[s].type]} on ${s}`);
    const undefended = attackers(grid, sq, me).length === 0;
    out.push({
      type: 'loose', sq, value: VALUE[p.type],
      text: `The ${NAME[p.type]} on ${sq} is ${undefended ? 'undefended and ' : ''}attacked by ${joinEn(by)}.`,
      arrows: att.map((s) => [s, sq]),
    });
  }
  if (!pos.inCheck()) {
    const them = passTurn(fen);
    if (them) {
      const mate = mateInOne(them);
      if (mate) out.push({ type: 'mateThreat', value: 100, text: `The opponent threatens mate with ${mate.san}.`, arrows: [[mate.from, mate.to]] });
      const seen = new Set();
      for (const mv of them.moves({ verbose: true })) {
        const a = analyzeMove(them.fen(), mv.san);
        const fk = a && a.motifs.find((x) => x.type === 'fork' && x.by === mv.to);
        if (fk && !seen.has(mv.san)) {
          seen.add(mv.san);
          out.push({ type: 'forkThreat', value: 50, text: `Fork threat: ${mv.san} (${fk.text.replace(/^Fork! /, '')})`, arrows: [[mv.from, mv.to], ...fk.arrows] });
        }
        if (seen.size >= 3) break;
      }
    }
  }
  return out.sort((a, b) => b.value - a.value);
}
