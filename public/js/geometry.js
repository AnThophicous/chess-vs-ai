// Arrow geometry for the player: where each piece COULD go by the way it moves (knight in an L,
// bishop on diagonals, pawn forward and capturing diagonally...). Blockers are ignored on purpose:
// an arrow is a plan ("once the pawn moves, the bishop goes to g5").
// Pure, no DOM: runs in the browser and in Node.
const FILES = 'abcdefgh';
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const AROUND = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const LINE = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const inside = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const name = (f, r) => FILES[f] + (r + 1);

/**
 * Squares the piece reaches from sq on an empty board.
 * @param {{type: 'p'|'n'|'b'|'r'|'q'|'k', color: 'w'|'b'}} piece
 * @param {string} sq e.g. 'g1'
 * @returns {string[]}
 */
export function reach(piece, sq) {
  const f = FILES.indexOf(sq[0]), r = Number(sq[1]) - 1;
  const out = [];
  const step = (dirs) => { for (const [df, dr] of dirs) if (inside(f + df, r + dr)) out.push(name(f + df, r + dr)); };
  const ray = (dirs) => { for (const [df, dr] of dirs) for (let k = 1; inside(f + df * k, r + dr * k); k++) out.push(name(f + df * k, r + dr * k)); };
  switch (piece.type) {
    case 'n': step(KNIGHT); break;
    case 'b': ray(DIAG); break;
    case 'r': ray(LINE); break;
    case 'q': ray(DIAG); ray(LINE); break;
    case 'k': {
      step(AROUND);
      const home = piece.color === 'w' ? 0 : 7;
      if (f === 4 && r === home) out.push(name(6, home), name(2, home)); // castling
      break;
    }
    case 'p': {
      const dir = piece.color === 'w' ? 1 : -1;
      step([[0, dir], [-1, dir], [1, dir]]); // one step forward, captures on the diagonals
      if (r === (piece.color === 'w' ? 1 : 6)) out.push(name(f, r + 2 * dir)); // two squares from the start
      break;
    }
  }
  return out;
}

/**
 * The square in the list closest to the pointer.
 * @param {string[]} squares
 * @param {number} pf continuous column (0 = left edge of file a, 8 = right edge of file h)
 * @param {number} pr continuous rank (0 = bottom edge of rank 1, 8 = top edge of rank 8)
 */
export function nearest(squares, pf, pr) {
  let best = null, bestD = Infinity;
  for (const s of squares) {
    const d = Math.hypot(FILES.indexOf(s[0]) + 0.5 - pf, Number(s[1]) - 0.5 - pr);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

/**
 * Destination of an arrow that starts at `from` with the pointer at (pf, pr): null when the pointer
 * is on the origin square itself (that becomes a mark); an empty square draws freely; a piece only
 * draws to where that piece can move.
 */
export function arrowTarget(piece, from, pf, pr) {
  const sq = FILES[Math.floor(pf)] + (Math.floor(pr) + 1);
  if (sq === from) return null;
  if (!piece) return sq;
  return nearest(reach(piece, from), pf, pr) ?? sq;
}
