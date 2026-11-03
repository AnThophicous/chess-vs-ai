// Board: drawing, drag/click, promotion, arrows, classification badges and tactic callouts.
import { Chess } from '../vendor/chess.js';
import { arrowTarget } from './geometry.js';

const FILES = 'abcdefgh';
const NS = 'http://www.w3.org/2000/svg';
const NAME = { q: 'Dama', r: 'Torre', b: 'Bispo', n: 'Cavalo' };
const COLOR = {
  hint: 'rgba(0, 113, 227, .85)', motif: 'rgba(255, 149, 0, .92)', bad: 'rgba(255, 59, 48, .88)',
  user: 'rgba(21, 120, 27, .8)', mark: 'rgba(235, 50, 35, .55)',
};
export const SHORT = {
  fork: 'Fork!', pin: 'Pin', skewer: 'Skewer', mate: 'Mate!', mateThreat: 'Mate threat',
  check: 'Xeque', doubleCheck: 'Xeque duplo', discoveredCheck: 'Xeque descoberto', hanging: 'Pendurada!',
  threat: 'Attack', freeCapture: 'Free', promotion: 'Promotion', castle: 'Castle', enPassant: 'En passant', capture: 'Capture',
};

export class BoardView {
  /**
   * @param {HTMLElement} el elemento .board
   * @param {{onMove: Function, onTouch: Function}} handlers
   */
  constructor(el, { onMove, onTouch } = {}) {
    this.el = el;
    this.onMove = onMove || (() => {});
    this.onTouch = onTouch || (() => {});
    this.squaresEl = el.querySelector('.squares');
    this.piecesEl = el.querySelector('.pieces');
    this.svg = el.querySelector('.arrows');
    this.badgesEl = el.querySelector('.badges');
    this.promoEl = el.querySelector('.promo');
    this.orient = 'w';
    this.myColor = 'w';
    this.chess = new Chess();
    this.interactive = false;
    this.showLegal = true;
    this.last = null;
    this.selected = null;
    this.targets = [];
    this.hintFrom = null;
    this.layers = { motif: [], hint: [], user: [] };
    this.marks = { motif: [], user: new Set() };
    this.badge = null;
    this.callout = null;
    this.drag = null;
    this.right = null;
    this.promoting = null;
    this.motifTimer = null;
    this.#buildSquares();
    this.#bind();
    this.#renderPieces(null);
  }

  // ---------- coordenadas ----------
  xy(sq) {
    const f = FILES.indexOf(sq[0]), r = Number(sq[1]);
    return this.orient === 'w' ? { x: f, y: 8 - r } : { x: 7 - f, y: r - 1 };
  }
  sqAtXY(x, y) { return this.orient === 'w' ? FILES[x] + (8 - y) : FILES[7 - x] + (y + 1); }
  sqAtPoint(cx, cy) {
    const r = this.el.getBoundingClientRect();
    const x = Math.floor(((cx - r.left) / r.width) * 8), y = Math.floor(((cy - r.top) / r.height) * 8);
    return x < 0 || x > 7 || y < 0 || y > 7 ? null : this.sqAtXY(x, y);
  }
  /** Pointer in continuous file/rank coordinates (a1 = 0,0), clamped to the board. */
  #pointer(e) {
    const r = this.el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 8, y = ((e.clientY - r.top) / r.height) * 8;
    const clamp = (v) => Math.min(7.999, Math.max(0, v));
    return this.orient === 'w' ? { pf: clamp(x), pr: clamp(8 - y) } : { pf: clamp(8 - x), pr: clamp(y) };
  }
  /** Destination of the arrow being drawn: only where the piece on the origin square can move (knight in an L, etc.). */
  #rightTarget(e) {
    const { pf, pr } = this.#pointer(e);
    return arrowTarget(this.chess.get(this.right.from), this.right.from, pf, pr);
  }
  get dragging() { return !!(this.drag && this.drag.moved) || !!this.promoting; }

  // ---------- public API ----------
  setOrientation(o) {
    if (o === this.orient) return;
    this.orient = o;
    this.#layoutSquares();
    this.#renderPieces(null);
    this.#renderHighlights();
    this.#drawArrows();
    this.#renderBadge();
  }

  setPosition(fen, { last = null, animate = null } = {}) {
    const changed = fen !== this.chess.fen();
    const lastChanged = (last?.from + last?.to) !== (this.last?.from + this.last?.to);
    this.last = last;
    if (changed) {
      this.chess = new Chess(fen);
      this.right = null;
      this.#cancelDrag();
      this.#closePromo(null);
      this.selected = null;
      this.targets = [];
      this.layers.user = [];
      this.marks.user.clear();
      this.#renderPieces(animate);
      this.#drawArrows();
    }
    if (changed || lastChanged) this.#renderHighlights();
  }

  setInteractive(on) {
    this.interactive = on;
    this.el.classList.toggle('can-move', on);
    if (!on && this.selected) this.#select(null);
  }

  setShowLegal(on) { this.showLegal = on; this.#renderHighlights(); }

  setHint(h) {
    const key = h ? `${h.from}${h.to || ''}` : '';
    if (key === this.hintKey) return;
    this.hintKey = key;
    this.hintFrom = h && !h.to ? h.from : null;
    this.layers.hint = h && h.to ? [{ from: h.from, to: h.to }] : [];
    this.#renderHighlights();
    this.#drawArrows();
  }
  clearHint() { this.setHint(null); }

  /** Shows a tactic (arrows, rings and a label). persist=false fades it away after a few seconds. */
  showMotif(m, { persist = false } = {}) {
    clearTimeout(this.motifTimer);
    const key = m ? m.text + persist : '';
    if (key === this.motifKey && persist) return;
    this.motifKey = key;
    if (!m) return this.clearMotif();
    const color = m.bad ? COLOR.bad : COLOR.motif;
    this.layers.motif = (m.arrows || []).map(([from, to]) => ({ from, to, color }));
    this.marks.motif = m.marks || [];
    const at = m.by || m.arrows?.[0]?.[0] || m.marks?.[0] || null;
    this.callout = at ? { sq: at, text: SHORT[m.type] || m.type, bad: !!m.bad } : null;
    this.#drawArrows(true);
    this.#renderBadge();
    if (!persist) {
      this.motifTimer = setTimeout(() => {
        this.svg.querySelectorAll('.motif').forEach((n) => n.classList.add('fade'));
        this.badgesEl.querySelector('.callout')?.classList.add('fade');
        this.motifTimer = setTimeout(() => this.clearMotif(), 650);
      }, 5200);
    }
  }
  clearMotif() {
    clearTimeout(this.motifTimer);
    this.motifKey = '';
    if (!this.layers.motif.length && !this.marks.motif.length && !this.callout) return;
    this.layers.motif = [];
    this.marks.motif = [];
    this.callout = null;
    this.#drawArrows();
    this.#renderBadge();
  }

  setBadge(b) {
    const key = b ? b.sq + b.cls : '';
    if (key === this.badgeKey) return;
    this.badgeKey = key;
    this.badge = b;
    this.#renderBadge(true);
  }

  /** Esc: closes the promotion picker or clears the selection. */
  escape() {
    if (this.promoting) return this.#closePromo(null);
    this.#select(null);
  }

  // ---------- casas ----------
  #buildSquares() {
    this.sqEls = [];
    for (let i = 0; i < 64; i++) {
      const d = document.createElement('div');
      this.squaresEl.appendChild(d);
      this.sqEls.push(d);
    }
    this.#layoutSquares();
  }

  #layoutSquares() {
    this.bySq = {};
    this.sqEls.forEach((d, i) => {
      const x = i % 8, y = Math.floor(i / 8);
      const sq = this.sqAtXY(x, y);
      const f = FILES.indexOf(sq[0]), r = Number(sq[1]);
      d.className = (f + r) % 2 === 1 ? 'sq dark' : 'sq';
      d.dataset.sq = sq;
      d.textContent = '';
      if (x === 0) d.insertAdjacentHTML('beforeend', `<span class="coord rank">${r}</span>`);
      if (y === 7) d.insertAdjacentHTML('beforeend', `<span class="coord file">${sq[0]}</span>`);
      this.bySq[sq] = d;
    });
  }

  #king(color) {
    const b = this.chess.board();
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = b[r][f];
      if (p && p.type === 'k' && p.color === color) return FILES[f] + (8 - r);
    }
    return null;
  }

  #renderHighlights() {
    const kingSq = this.chess.inCheck() ? this.#king(this.chess.turn()) : null;
    for (const sq in this.bySq) {
      const d = this.bySq[sq];
      d.classList.toggle('last', !!this.last && (sq === this.last.from || sq === this.last.to));
      d.classList.toggle('sel', sq === this.selected);
      d.classList.toggle('check', sq === kingSq);
      d.classList.toggle('hintfrom', sq === this.hintFrom);
      d.querySelectorAll('.dot, .ring').forEach((n) => n.remove());
      if (this.showLegal && this.targets.includes(sq)) {
        const e = document.createElement('div');
        e.className = this.chess.get(sq) ? 'ring' : 'dot';
        d.appendChild(e);
      }
    }
  }

  // ---------- pieces ----------
  #place(el, sq) {
    const { x, y } = this.xy(sq);
    el.style.setProperty('--x', x);
    el.style.setProperty('--y', y);
  }

  #pieceEl(p, sq) {
    const d = document.createElement('div');
    d.className = 'piece' + (p.color === this.myColor ? ' mine' : '');
    d.dataset.sq = sq;
    d.innerHTML = `<img src="pieces/${p.color}${p.type}.svg" alt="" width="45" height="45" draggable="false">`;
    this.#place(d, sq);
    return d;
  }

  #renderPieces(anim) {
    let ghost = null;
    if (anim && anim.captured) {
      const capSq = anim.flags.includes('e') ? anim.to[0] + anim.from[1] : anim.to;
      ghost = this.piecesEl.querySelector(`.piece[data-sq="${capSq}"]`);
    }
    this.piecesEl.textContent = '';
    const frag = document.createDocumentFragment();
    const b = this.chess.board();
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) if (b[r][f]) frag.appendChild(this.#pieceEl(b[r][f], FILES[f] + (8 - r)));
    if (ghost) {
      ghost.classList.add('ghost');
      frag.prepend(ghost);
      setTimeout(() => ghost.remove(), 260);
    }
    this.piecesEl.appendChild(frag);
    if (anim) {
      this.#slide(anim.from, anim.to);
      if (anim.flags.includes('k') || anim.flags.includes('q')) {
        const rank = anim.to[1];
        if (anim.to[0] === 'g') this.#slide('h' + rank, 'f' + rank); else this.#slide('a' + rank, 'd' + rank);
      }
    }
  }

  #slide(from, to) {
    const el = this.piecesEl.querySelector(`.piece[data-sq="${to}"]:not(.ghost)`);
    if (!el) return;
    el.style.transition = 'none';
    this.#place(el, from);
    void el.offsetWidth;
    el.style.transition = '';
    this.#place(el, to);
  }

  // ---------- arrows, rings, badges ----------
  #drawArrows(animate = false) {
    const svg = this.svg;
    svg.textContent = '';
    for (const sq of this.marks.user) {
      const { x, y } = this.xy(sq);
      svg.appendChild(this.#el('rect', { x, y, width: 1, height: 1, fill: COLOR.mark }));
    }
    for (const sq of this.marks.motif) {
      const { x, y } = this.xy(sq);
      svg.appendChild(this.#el('circle', { cx: x + 0.5, cy: y + 0.5, r: 0.45, fill: 'none', stroke: COLOR.motif, 'stroke-width': 0.07, class: 'motif' + (animate ? ' anim' : '') }));
    }
    for (const a of this.layers.motif) svg.appendChild(this.#arrow(a.from, a.to, a.color || COLOR.motif, 'motif' + (animate ? ' anim' : '')));
    for (const a of this.layers.hint) svg.appendChild(this.#arrow(a.from, a.to, COLOR.hint, 'anim'));
    for (const a of this.layers.user) svg.appendChild(this.#arrow(a.from, a.to, COLOR.user, ''));
    if (this.right?.to) svg.appendChild(this.#arrow(this.right.from, this.right.to, COLOR.user, 'preview'));
  }

  #el(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  #arrow(from, to, color, cls) {
    const a = this.xy(from), b = this.xy(to);
    const x1 = a.x + 0.5, y1 = a.y + 0.5, x2 = b.x + 0.5, y2 = b.y + 0.5;
    const dx = x2 - x1, dy = y2 - y1;
    const knight = (Math.abs(dx) === 1 && Math.abs(dy) === 2) || (Math.abs(dx) === 2 && Math.abs(dy) === 1);
    const pts = knight
      ? (Math.abs(dy) > Math.abs(dx) ? [[x1, y1], [x1, y2], [x2, y2]] : [[x1, y1], [x2, y1], [x2, y2]])
      : [[x1, y1], [x2, y2]];
    const unit = (p, q) => { const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };
    const [sx, sy] = unit(pts[0], pts[1]);
    const start = [pts[0][0] + sx * 0.22, pts[0][1] + sy * 0.22];
    const end = pts.at(-1);
    const [ux, uy] = unit(pts.at(-2), end);
    const head = 0.42, half = 0.27;
    const base = [end[0] - ux * head, end[1] - uy * head];
    const tip = [end[0] - ux * 0.06, end[1] - uy * 0.06];
    const g = this.#el('g', { class: cls });
    g.appendChild(this.#el('polyline', {
      points: [start, ...pts.slice(1, -1), base].map((p) => p.join(',')).join(' '),
      fill: 'none', stroke: color, 'stroke-width': 0.17, 'stroke-linejoin': 'round',
    }));
    g.appendChild(this.#el('polygon', {
      points: `${tip.join(',')} ${base[0] - uy * half},${base[1] + ux * half} ${base[0] + uy * half},${base[1] - ux * half}`,
      fill: color,
    }));
    return g;
  }

  #renderBadge(pop = false) {
    this.badgesEl.textContent = '';
    if (this.badge) {
      const { x, y } = this.xy(this.badge.sq);
      const d = document.createElement('div');
      d.className = 'badge';
      d.style.setProperty('--x', x);
      d.style.setProperty('--y', y);
      const s = document.createElement('span');
      s.textContent = this.badge.sym;
      s.style.background = this.badge.color;
      s.title = this.badge.label;
      if (!pop) s.style.animation = 'none';
      d.appendChild(s);
      this.badgesEl.appendChild(d);
    }
    if (this.callout) {
      const { x, y } = this.xy(this.callout.sq);
      const c = document.createElement('div');
      c.className = 'callout' + (this.callout.bad ? ' bad' : '');
      c.textContent = this.callout.text;
      // On the top rank the label goes below the piece, otherwise it would leave the board.
      const below = y === 0;
      c.style.left = `${(x + 0.5) * 12.5}%`;
      c.style.top = `${(below ? y + 1 : y) * 12.5}%`;
      c.style.transform = `translate(-50%, ${below ? '12%' : '-112%'})`;
      if (x === 0) c.style.transform = `translate(-12%, ${below ? '12%' : '-112%'})`;
      if (x === 7) c.style.transform = `translate(-88%, ${below ? '12%' : '-112%'})`;
      this.badgesEl.appendChild(c);
    }
  }

  // ---------- interaction ----------
  #bind() {
    const el = this.el;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => this.#down(e));
    el.addEventListener('pointermove', (e) => this.#move(e));
    el.addEventListener('pointerup', (e) => this.#up(e));
    el.addEventListener('pointercancel', () => {
      if (this.right) { this.right = null; this.#drawArrows(); }
      this.#cancelDrag();
    });
  }

  #select(sq) {
    this.selected = sq;
    this.targets = sq ? this.chess.moves({ square: sq, verbose: true }).map((m) => m.to) : [];
    this.#renderHighlights();
  }

  #down(e) {
    if (e.target.closest('.promo, .review-pill')) return;
    this.onTouch(e);
    const sq = this.sqAtPoint(e.clientX, e.clientY);
    if (!sq) return;
    if (e.button === 2) {
      this.right = { from: sq, to: null, id: e.pointerId };
      try { this.el.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    if (e.button !== 0) return;
    if (this.layers.user.length || this.marks.user.size) { this.layers.user = []; this.marks.user.clear(); this.#drawArrows(); }
    if (!this.interactive) { this.#select(null); return; }
    if (this.selected && this.targets.includes(sq)) { this.#tryMove(this.selected, sq, false); return; }
    const p = this.chess.get(sq);
    if (p && p.color === this.myColor) {
      const wasSelected = this.selected === sq;
      this.#select(sq);
      this.drag = { sq, el: this.piecesEl.querySelector(`.piece[data-sq="${sq}"]:not(.ghost)`), x0: e.clientX, y0: e.clientY, moved: false, wasSelected, id: e.pointerId, over: null };
      try { this.el.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    this.#select(null);
  }

  #move(e) {
    if (this.right) {
      const to = this.#rightTarget(e);
      if (to !== this.right.to) { this.right.to = to; this.#drawArrows(); }
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
    if (!d.moved) { d.moved = true; d.el?.classList.add('dragging'); }
    const r = this.el.getBoundingClientRect();
    const s = r.width / 8;
    d.el?.style.setProperty('--px', `${e.clientX - r.left - s / 2}px`);
    d.el?.style.setProperty('--py', `${e.clientY - r.top - s / 2}px`);
    const over = this.sqAtPoint(e.clientX, e.clientY);
    if (over !== d.over) {
      if (d.over) this.bySq[d.over]?.classList.remove('hover');
      d.over = over;
      if (over && this.targets.includes(over)) this.bySq[over].classList.add('hover');
    }
  }

  #up(e) {
    if (this.right) {
      const from = this.right.from;
      const to = this.#rightTarget(e);
      try { this.el.releasePointerCapture(this.right.id); } catch {}
      this.right = null;
      if (!to) {
        if (this.marks.user.has(from)) this.marks.user.delete(from); else this.marks.user.add(from);
      } else {
        const i = this.layers.user.findIndex((a) => a.from === from && a.to === to);
        if (i >= 0) this.layers.user.splice(i, 1); else this.layers.user.push({ from, to });
      }
      this.#drawArrows();
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.el.releasePointerCapture(d.id); } catch {}
    if (d.over) this.bySq[d.over]?.classList.remove('hover');
    d.el?.classList.remove('dragging');
    if (!d.moved) { if (d.wasSelected) this.#select(null); return; }
    const to = this.sqAtPoint(e.clientX, e.clientY);
    if (to && to !== d.sq && this.targets.includes(to)) this.#tryMove(d.sq, to, true);
  }

  #cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.over) this.bySq[d.over]?.classList.remove('hover');
    d.el?.classList.remove('dragging');
  }

  async #tryMove(from, to, dragged) {
    const options = this.chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!options.length) { this.#select(null); return; }
    let promotion;
    if (options.some((m) => m.promotion)) {
      if (dragged) { const el = this.piecesEl.querySelector(`.piece[data-sq="${from}"]`); if (el) { el.style.transition = 'none'; this.#place(el, to); } }
      promotion = await this.#askPromotion(to, this.chess.get(from).color);
      if (!promotion) { this.#select(null); this.#renderPieces(null); return; }
    }
    this.#select(null);
    this.onMove({ from, to, promotion, dragged });
  }

  #askPromotion(to, color) {
    return new Promise((resolve) => {
      this.promoting = resolve;
      const { x, y } = this.xy(to);
      const down = y === 0; // promotion square at the top: the column goes down
      const col = document.createElement('div');
      col.className = 'promo-col' + (down ? '' : ' up');
      col.style.left = `${x * 12.5}%`;
      col.style[down ? 'top' : 'bottom'] = '0';
      col.setAttribute('role', 'dialog');
      col.setAttribute('aria-label', 'Choose the promotion piece');
      for (const t of ['q', 'n', 'r', 'b']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = NAME[t];
        b.setAttribute('aria-label', NAME[t]);
        b.innerHTML = `<img src="pieces/${color}${t}.svg" alt="" width="45" height="45">`;
        b.addEventListener('click', () => this.#closePromo(t));
        col.appendChild(b);
      }
      const x2 = document.createElement('button');
      x2.type = 'button';
      x2.className = 'close';
      x2.setAttribute('aria-label', 'Cancel promotion');
      x2.textContent = '×';
      x2.addEventListener('click', () => this.#closePromo(null));
      col.appendChild(x2);
      this.promoEl.textContent = '';
      this.promoEl.appendChild(col);
      this.promoEl.hidden = false;
      this.promoEl.onpointerdown = (e) => { if (e.target === this.promoEl) this.#closePromo(null); };
      col.querySelector('button').focus({ preventScroll: true });
    });
  }

  #closePromo(choice) {
    if (!this.promoting) return;
    const resolve = this.promoting;
    this.promoting = null;
    this.promoEl.hidden = true;
    this.promoEl.textContent = '';
    resolve(choice);
  }
}
