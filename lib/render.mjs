// Draws the board as SVG and converts it to PNG (resvg), so an AI can "see" the game.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { Chess } from 'chess.js';
import { CLASSES } from '../public/js/review.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = 'abcdefgh';
const SQ = 80;
const HEAD = 52;

const PIECES = {};
for (const c of 'wb') for (const t of 'pnbrqk') {
  const raw = fs.readFileSync(path.join(ROOT, 'public', 'pieces', `${c}${t}.svg`), 'utf8');
  PIECES[c + t] = raw.slice(raw.indexOf('>') + 1, raw.lastIndexOf('</svg>'));
}

const THEME = { light: '#ebecd0', dark: '#739552', lastLight: '#f5f682', lastDark: '#b9ca43', text: '#1d1d1f' };
export const ARROW = {
  best: 'rgba(21,120,27,0.85)', alt: 'rgba(21,120,27,0.45)', motif: 'rgba(255,149,0,0.9)',
  threat: 'rgba(235,50,35,0.85)', hint: 'rgba(0,113,227,0.85)',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function center(sq, orient) {
  let f = FILES.indexOf(sq[0]), r = 8 - Number(sq[1]);
  if (orient === 'b') { f = 7 - f; r = 7 - r; }
  return [(f + 0.5) * SQ, HEAD + (r + 0.5) * SQ];
}

function arrowSvg(from, to, color, orient) {
  const [x1, y1] = center(from, orient), [x2, y2] = center(to, orient);
  const dx = x2 - x1, dy = y2 - y1;
  const knight = (Math.abs(dx) === SQ && Math.abs(dy) === 2 * SQ) || (Math.abs(dx) === 2 * SQ && Math.abs(dy) === SQ);
  // Knight: L-shaped arrow (longest axis first), like chess.com
  const pts = knight ? (Math.abs(dy) > Math.abs(dx) ? [[x1, y1], [x1, y2], [x2, y2]] : [[x1, y1], [x2, y1], [x2, y2]]) : [[x1, y1], [x2, y2]];
  const [ax, ay] = pts.at(-2), [bx, by] = pts.at(-1);
  const len = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / len, uy = (by - ay) / len;
  const head = SQ * 0.42, half = SQ * 0.26, shaft = SQ * 0.17;
  const baseX = bx - ux * head, baseY = by - uy * head;
  const start = pts[0];
  const sx = start[0] + (pts[1][0] - start[0]) / (Math.hypot(pts[1][0] - start[0], pts[1][1] - start[1]) || 1) * SQ * 0.25;
  const sy = start[1] + (pts[1][1] - start[1]) / (Math.hypot(pts[1][0] - start[0], pts[1][1] - start[1]) || 1) * SQ * 0.25;
  const line = [[sx, sy], ...pts.slice(1, -1), [baseX, baseY]].map((p) => p.join(',')).join(' ');
  const tip = `${bx - ux * SQ * 0.06},${by - uy * SQ * 0.06}`;
  const left = `${baseX - uy * half},${baseY + ux * half}`, right = `${baseX + uy * half},${baseY - ux * half}`;
  return `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="${shaft}" stroke-linejoin="round"/>` +
    `<polygon points="${tip} ${left} ${right}" fill="${color}"/>`;
}

/**
 * @param {object} o
 * @param {string} o.fen
 * @param {'w'|'b'} [o.orient]
 * @param {{from,to}} [o.last]
 * @param {Array<{from,to,color}>} [o.arrows]
 * @param {string[]} [o.marks] squares to ring
 * @param {string} [o.badge] CLASSES key for the badge on the last move
 * @param {string} [o.caption] header text
 * @param {string} [o.evalText] evaluation shown in the header corner
 */
export function boardSvg({ fen, orient = 'w', last = null, arrows = [], marks = [], badge = null, caption = '', evalText = '' }) {
  const chess = new Chess(fen);
  const W = SQ * 8, H = HEAD + SQ * 8;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
  out.push(`<rect width="${W}" height="${H}" fill="#1c1c1e"/>`);
  out.push(`<text x="16" y="33" font-family="Inter, Noto Sans, DejaVu Sans, sans-serif" font-size="19" font-weight="600" fill="#f5f5f7">${esc(caption)}</text>`);
  if (evalText) out.push(`<text x="${W - 16}" y="33" text-anchor="end" font-family="Inter, Noto Sans, DejaVu Sans, sans-serif" font-size="19" font-weight="700" fill="#f5f5f7">${esc(evalText)}</text>`);
  out.push(`<defs><radialGradient id="chk"><stop offset="0" stop-color="#ff2828"/><stop offset="0.45" stop-color="#e60000" stop-opacity="0.75"/><stop offset="0.75" stop-color="#e60000" stop-opacity="0"/></radialGradient></defs>`);

  const board = chess.board();
  const kingInCheck = chess.inCheck() ? chess.turn() : null;
  for (let vr = 0; vr < 8; vr++) for (let vf = 0; vf < 8; vf++) {
    const f = orient === 'w' ? vf : 7 - vf, r = orient === 'w' ? vr : 7 - vr;
    const sq = FILES[f] + (8 - r);
    const light = (f + r) % 2 === 0;
    const isLast = last && (sq === last.from || sq === last.to);
    const fill = isLast ? (light ? THEME.lastLight : THEME.lastDark) : light ? THEME.light : THEME.dark;
    const x = vf * SQ, y = HEAD + vr * SQ;
    out.push(`<rect x="${x}" y="${y}" width="${SQ}" height="${SQ}" fill="${fill}"/>`);
    const p = board[r][f];
    if (p && p.type === 'k' && p.color === kingInCheck) out.push(`<rect x="${x}" y="${y}" width="${SQ}" height="${SQ}" fill="url(#chk)"/>`);
    const coordColor = light ? THEME.dark : THEME.light;
    if (vf === 0) out.push(`<text x="${x + 5}" y="${y + 17}" font-family="Inter, Noto Sans, DejaVu Sans, sans-serif" font-size="15" font-weight="700" fill="${coordColor}">${8 - r}</text>`);
    if (vr === 7) out.push(`<text x="${x + SQ - 5}" y="${y + SQ - 6}" text-anchor="end" font-family="Inter, Noto Sans, DejaVu Sans, sans-serif" font-size="15" font-weight="700" fill="${coordColor}">${FILES[f]}</text>`);
  }
  for (const sq of marks) {
    const [cx, cy] = center(sq, orient);
    out.push(`<circle cx="${cx}" cy="${cy}" r="${SQ * 0.44}" fill="none" stroke="${ARROW.motif}" stroke-width="5"/>`);
  }
  for (let vr = 0; vr < 8; vr++) for (let vf = 0; vf < 8; vf++) {
    const f = orient === 'w' ? vf : 7 - vf, r = orient === 'w' ? vr : 7 - vr;
    const p = board[r][f];
    if (!p) continue;
    out.push(`<svg x="${vf * SQ + SQ * 0.03}" y="${HEAD + vr * SQ + SQ * 0.03}" width="${SQ * 0.94}" height="${SQ * 0.94}" viewBox="0 0 45 45">${PIECES[p.color + p.type]}</svg>`);
  }
  for (const a of arrows) out.push(arrowSvg(a.from, a.to, a.color || ARROW.best, orient));
  if (badge && last && CLASSES[badge]) {
    const [cx, cy] = center(last.to, orient);
    const bx = cx + SQ * 0.36, by = cy - SQ * 0.36;
    out.push(`<circle cx="${bx}" cy="${by}" r="15" fill="${CLASSES[badge].color}" stroke="#fff" stroke-width="2"/>`);
    out.push(`<text x="${bx}" y="${by + 6}" text-anchor="middle" font-family="Inter, Noto Sans, DejaVu Sans, sans-serif" font-size="16" font-weight="800" fill="#fff">${esc(CLASSES[badge].sym)}</text>`);
  }
  out.push('</svg>');
  return out.join('');
}

export function boardPng(opts) {
  return new Resvg(boardSvg(opts), { font: { loadSystemFonts: true, defaultFontFamily: 'Noto Sans' } }).render().asPng();
}
