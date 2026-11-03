// Move classification in the style of chess.com's game review.
// Used by the server (to compute) and by the browser (to draw the badge).

export const CLASSES = {
  brilliant: { label: 'Brilliant', sym: '!!', color: '#1baca6' },
  best: { label: 'Best move', sym: '★', color: '#81b64c' },
  excellent: { label: 'Excellent', sym: '!', color: '#81b64c' },
  good: { label: 'Good', sym: '✓', color: '#95af8a' },
  book: { label: 'Book', sym: 'T', color: '#a88865' },
  forced: { label: 'Forced', sym: '□', color: '#97a3a8' },
  inaccuracy: { label: 'Inaccuracy', sym: '?!', color: '#f7c631' },
  mistake: { label: 'Mistake', sym: '?', color: '#ff9a3c' },
  blunder: { label: 'Blunder', sym: '??', color: '#fa412d' },
};

/** Winning chance (−1 to 1) from centipawns, the same curve lichess uses. */
export function winChance(cp) {
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}

/** Converts an evaluation {cp, mate} (from White's point of view) into centipawns. */
export function toCp(ev) {
  if (!ev) return 0;
  if (ev.mate !== undefined && ev.mate !== null) return ev.mate > 0 ? 2000 : ev.mate < 0 ? -2000 : ev.cp ?? 0;
  return ev.cp ?? 0;
}

/**
 * @param before evaluation of the position before the move (White's POV), with .best in UCI
 * @param after  evaluation after the move (White's POV)
 * @param mover  'w' | 'b'
 */
export function classify({ before, after, mover, uci, legalCount, book, sacrifice }) {
  if (legalCount === 1) return 'forced';
  if (book) return 'book';
  if (!before || !after) return null;
  const s = mover === 'w' ? 1 : -1;
  const wcBefore = winChance(s * toCp(before));
  const wcAfter = winChance(s * toCp(after));
  const loss = wcBefore - wcAfter;
  const isBest = before.best && before.best === uci;
  if ((isBest || loss < 0.02) && sacrifice && wcAfter > -0.1 && wcBefore < 0.9) return 'brilliant';
  if (isBest) return 'best';
  if (loss < 0.04) return 'excellent';
  if (loss < 0.1) return 'good';
  if (loss < 0.2) return 'inaccuracy';
  if (loss < 0.3) return 'mistake';
  return 'blunder';
}

/** Short evaluation text: "+1.4", "−0.3", "M3", "−M2". */
export function evalLabel(ev) {
  if (!ev) return '…';
  if (ev.mate !== undefined && ev.mate !== null) {
    if (ev.mate === 0) return ev.cp > 0 ? '1-0' : ev.cp < 0 ? '0-1' : '½';
    return (ev.mate < 0 ? '−' : '') + 'M' + Math.abs(ev.mate);
  }
  const v = (ev.cp ?? 0) / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
}
