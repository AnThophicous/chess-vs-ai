// Game UI. The server is the source of truth; here we only draw and send actions.
import { Chess } from '../vendor/chess.js';
import { BoardView } from './board.js';
import { Sound } from './sound.js';
import { CLASSES, winChance, toCp } from './review.js';

const $ = (s) => document.querySelector(s);
const PIECE = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const QUICK = ['LMAO', 'No crying', 'Beginner luck', 'Just play', 'Scared?', 'That hurt', 'GG'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- preferences ----------
const DEFAULTS = { legal: true, sound: true, tactics: true, badges: true, evalbar: true, board: 'green', flip: false, hintLevel: 2 };
const prefs = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('chess.prefs') || '{}') };
  } catch { return { ...DEFAULTS }; }
})();
const savePrefs = () => { try { localStorage.setItem('chess.prefs', JSON.stringify(prefs)); } catch {} };

// ---------- state ----------
let S = null;            // state from the server
let view = null;         // null = live; a number = half-move being reviewed
let busy = false;        // sending a move
let hint = null;         // hint for the current position
let hintBusy = false;
let hintMsg = null;
let online = true;
let lastMotifPly = null;
let lastEval = null;

const sound = new Sound(prefs.sound);
const board = new BoardView($('#board'), {
  onMove: (m) => playMove(m),
  onTouch: () => { sound.unlock(); if (view !== null) setView(null); },
});

// ---------- server ----------
async function api(method, url, body) {
  const r = await fetch(url, {
    method, cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'That did not work. Try again.');
  return j;
}

async function pollState() {
  if (busy || board.dragging) return;
  try {
    const s = await api('GET', '/api/state' + (S ? `?v=${S.v}` : ''));
    setOnline(true);
    if (!s.same) apply(s);
  } catch {
    setOnline(false);
  }
}

function setOnline(ok) {
  if (ok === online) return;
  online = ok;
  if (!ok) { $('#turnText').textContent = 'Server offline'; $('#turnChip').dataset.state = 'over'; }
  else render();
}

// ---------- apply state ----------
function apply(ns) {
  const prev = S;
  S = ns;
  const newGame = !prev || prev.id !== ns.id;
  if (newGame) {
    view = null; hint = null; hintMsg = null; lastMotifPly = null; lastEval = null;
    board.clearMotif();
    if (prev) { sound.play('start'); closeResult(); }
  }
  if (hint && (hint.ply !== ns.ply || ns.turn !== 'w' || ns.status !== 'playing')) hint = null;
  if (view !== null && view >= ns.ply) view = null;
  const advanced = prev && !newGame && ns.ply === prev.ply + 1;
  render({ animate: advanced && !ns._dragged });
  if (advanced) moveSound(ns.ply - 1);
  showNewMotif();
  if (prev && !newGame && prev.status === 'playing' && ns.status === 'over') setTimeout(openResult, 700);
}

function lastMoveObj(ply) {
  if (!S || ply < 1) return null;
  try { const u = S.uci[ply - 1]; return new Chess(S.fens[ply - 1]).move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { return null; }
}

function moveSound(i) {
  const m = lastMoveObj(i + 1);
  if (!m) return;
  if (m.san.includes('#')) return sound.play('check');
  if (m.promotion) return sound.play('promote');
  if (m.san.includes('+')) return sound.play('check');
  if (m.flags.includes('k') || m.flags.includes('q')) return sound.play('castle');
  sound.play(m.captured ? 'capture' : 'move');
}

// Shows the tactic of the last move as soon as the server sends its analysis.
function showNewMotif() {
  if (!S || view !== null || !S.ply || lastMotifPly === `${S.id}:${S.ply}`) return;
  const note = S.notes[S.ply - 1];
  if (!note) return;
  lastMotifPly = `${S.id}:${S.ply}`;
  const m = note.motifs?.[0];
  if (prefs.tactics && m && m.type !== 'capture' && m.type !== 'castle') board.showMotif(m);
}

// ---------- drawing ----------
function render({ animate = false } = {}) {
  if (!S) return;
  const ply = view ?? S.ply;
  const fen = S.fens[ply];
  const u = ply > 0 ? S.uci[ply - 1] : null;
  const last = u ? { from: u.slice(0, 2), to: u.slice(2, 4) } : null;
  board.setPosition(fen, { last, animate: animate && view === null ? lastMoveObj(ply) : null });
  board.setInteractive(view === null && S.status === 'playing' && S.turn === 'w' && !busy && online);
  const note = ply > 0 ? S.notes[ply - 1] : null;
  board.setBadge(prefs.badges && note?.cls && last ? { sq: last.to, cls: note.cls, ...CLASSES[note.cls] } : null);
  if (hint && view === null) board.setHint(hint.level === 1 ? { from: hint.from } : { from: hint.from, to: hint.to });
  else board.clearHint();
  if (view !== null) {
    const m = note?.motifs?.[0];
    if (prefs.tactics && m) board.showMotif(m, { persist: true }); else board.clearMotif();
  }
  renderPlayers(fen);
  renderEval(ply);
  renderMoves();
  renderCoach(ply);
  renderStatus();
  renderHint();
  renderActions();
  $('#board').classList.toggle('review', view !== null);
  $('#reviewPill').hidden = view === null;
  if (view !== null) $('#reviewText').textContent = view === 0 ? 'Starting position' : `Reviewing ${Math.ceil(view / 2)}${view % 2 ? '.' : '…'} ${S.moves[view - 1]}`;
  document.querySelectorAll('.nav button').forEach((b) => {
    const back = b.dataset.nav === 'first' || b.dataset.nav === 'prev';
    b.disabled = back ? ply === 0 : view === null;
  });
}

function fig(san, color) {
  const img = (l) => `<img src="pieces/${color}${l.toLowerCase()}.svg" alt="${PIECE[l.toLowerCase()]}" width="18" height="18">`;
  return `<span class="san">${esc(san).replace(/^([KQRBN])/, (_, l) => img(l)).replace(/=([QRBN])/, (_, l) => '=' + img(l))}</span>`;
}

// ---------- players ----------
const rows = {};
function buildRows() {
  const mk = (who) => {
    const el = document.createElement('div');
    el.className = `player ${who}`;
    el.innerHTML = who === 'ai'
      ? `<div class="bubble" data-bubble></div><div class="avatar ai" aria-hidden="true">A</div>
         <div class="pinfo"><div class="pname">AI <small>black</small></div><div class="pmeta" data-meta></div></div>
         <div class="captures" data-cap></div>`
      : `<div class="avatar player" aria-hidden="true">P</div>
         <div class="pinfo"><div class="pname">You <small>white</small></div><div class="pmeta" data-meta></div></div>
         <div class="captures" data-cap></div>`;
    return el;
  };
  rows.ai = mk('ai');
  rows.player = mk('player');
  $('#rowTop').replaceWith(document.createComment('top'));
  $('#rowBottom').replaceWith(document.createComment('bottom'));
  placeRows();
}
function placeRows() {
  const stage = $('.stage'), boardRow = $('.board-row');
  const top = prefs.flip ? rows.player : rows.ai, bottom = prefs.flip ? rows.ai : rows.player;
  stage.insertBefore(top, boardRow);
  boardRow.after(bottom);
  top.classList.add('top'); top.classList.remove('bottom');
  bottom.classList.add('bottom'); bottom.classList.remove('top');
}

function material(fen) {
  const START = { q: 1, r: 2, b: 2, n: 2, p: 8 }, V = { q: 9, r: 5, b: 3, n: 3, p: 1 };
  const n = { w: { q: 0, r: 0, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 0, p: 0 } };
  for (const ch of fen.split(' ')[0]) {
    const t = ch.toLowerCase();
    if (t in V) n[ch === t ? 'b' : 'w'][t]++;
  }
  const missing = (c) => Object.keys(START).flatMap((t) => Array(Math.max(0, START[t] - n[c][t])).fill(t));
  const sum = (c) => Object.keys(V).reduce((s, t) => s + V[t] * n[c][t], 0);
  return { byWhite: missing('b'), byBlack: missing('w'), diff: sum('w') - sum('b') };
}

function capturesHtml(list, color, adv) {
  const groups = {};
  for (const t of list) (groups[t] ||= []).push(t);
  const html = ['p', 'n', 'b', 'r', 'q'].filter((t) => groups[t])
    .map((t) => `<span class="grp">${groups[t].map(() => `<img src="pieces/${color}${t}.svg" alt="" width="20" height="20">`).join('')}</span>`).join('');
  return html + (adv > 0 ? `<span class="adv">+${adv}</span>` : '');
}

function renderPlayers(fen) {
  const mat = material(fen);
  rows.player.querySelector('[data-cap]').innerHTML = capturesHtml(mat.byWhite, 'b', mat.diff);
  rows.ai.querySelector('[data-cap]').innerHTML = capturesHtml(mat.byBlack, 'w', -mat.diff);
  const h = S.hints.count, a = S.assists.count;
  const ym = rows.player.querySelector('[data-meta]');
  ym.className = 'pmeta' + (h >= 8 ? ' burning' : h >= 4 ? ' hot' : '');
  ym.innerHTML = `<svg><use href="#i-bulb"/></svg><span>${h === 0 ? 'No hints yet' : `${h} ${h === 1 ? 'hint' : 'hints'} from Stockfish${h >= 8 ? ' · Stockfish thanks you' : ''}`}</span>`;
  const cm = rows.ai.querySelector('[data-meta]');
  cm.innerHTML = `<svg><use href="#i-chip"/></svg><span>${a === 0 ? 'No engine use yet' : `Consulted the engine ${a}×`}</span>`;
}

// ---------- evaluation bar ----------
function renderEval(ply) {
  const bar = $('#evalbar');
  bar.style.visibility = prefs.evalbar ? 'visible' : 'hidden';
  let ev = S.evals[ply];
  bar.classList.toggle('pending', !ev);
  if (ev) lastEval = ev; else ev = lastEval;
  const flipped = prefs.flip;
  bar.classList.toggle('flipped', flipped);
  const fill = $('#evalFill'), num = $('#evalNum');
  if (!ev) { fill.style.height = '50%'; num.textContent = ''; return; }
  const white = 0.5 + 0.5 * winChance(toCp(ev));
  fill.style.height = `${(white * 100).toFixed(1)}%`;
  const whiteLeads = ev.mate ? ev.mate > 0 : ev.mate === 0 ? ev.cp > 0 : ev.cp >= 0;
  const text = ev.mate !== undefined && ev.mate !== null ? (ev.mate === 0 ? (ev.cp > 0 ? '1-0' : '0-1') : `M${Math.abs(ev.mate)}`) : Math.abs(ev.cp / 100).toFixed(1);
  num.textContent = text;
  const atBottom = whiteLeads !== flipped;
  num.className = 'num ' + (atBottom ? 'at-bottom' : 'at-top');
  num.style.color = whiteLeads ? '#403d39' : '#f5f5f2';
  bar.setAttribute('aria-label', `Evaluation: ${whiteLeads ? 'White' : 'Black'} ${text}`);
}

// ---------- move list ----------
let movesKey = '';
function renderMoves() {
  const cur = view ?? S.ply;
  const key = `${S.id}:${S.v}:${cur}:${prefs.badges}:${S.moves.length}`;
  if (key === movesKey) return;
  movesKey = key;
  const ol = $('#moveList');
  const op = S.opening;
  $('#opening').innerHTML = op ? `<span>Opening</span><b>${esc(op.name)}</b>` : '';
  $('#subtitle').textContent = op ? op.name : 'You (White) against the AI (Black)';
  if (!S.moves.length) { ol.innerHTML = '<li class="empty">No moves yet. You start as White.</li>'; return; }
  const cell = (i) => {
    if (i >= S.moves.length) return '<span></span>';
    const n = S.notes[i] || {};
    const c = prefs.badges && n.cls ? CLASSES[n.cls] : null;
    const color = i % 2 === 0 ? 'w' : 'b';
    const flags = [
      n.hint ? `<svg class="mflag${n.hint === 'followed' ? ' on' : ''}" aria-label="${n.hint === 'followed' ? 'Hint move' : 'Asked for a hint'}"><title>${n.hint === 'followed' ? 'Played the hinted move' : 'Asked for a hint on this move'}</title><use href="#i-bulb"/></svg>` : '',
      n.engine ? `<svg class="mflag${n.engine === 'followed' ? ' on' : ''}"><title>${n.engine === 'followed' ? 'The AI played the engine move' : 'The AI consulted the engine'}</title><use href="#i-chip"/></svg>` : '',
    ].join('');
    return `<button type="button" data-ply="${i + 1}"${cur === i + 1 ? ' aria-current="true"' : ''}>${c ? `<span class="mcls" style="background:${c.color}" title="${c.label}">${esc(c.sym)}</span>` : ''}${fig(S.moves[i], color)}${flags}</button>`;
  };
  let html = '';
  for (let i = 0; i < S.moves.length; i += 2) html += `<li><span class="n">${i / 2 + 1}.</span>${cell(i)}${cell(i + 1)}</li>`;
  if (S.status === 'over') html += `<li class="result-row">${esc(S.result.text)}</li>`;
  ol.innerHTML = html;
  const active = ol.querySelector('[aria-current="true"]');
  if (active) active.scrollIntoView({ block: 'nearest' });
  else if (view === null) ol.scrollTop = ol.scrollHeight;
}
$('#moveList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ply]');
  if (!b) return;
  const p = Number(b.dataset.ply);
  setView(p === S.ply ? null : p);
});

function setView(v) {
  if (!S) return;
  view = v === null || v >= S.ply ? null : Math.max(0, v);
  board.clearMotif();
  lastMotifPly = `${S.id}:${S.ply}`;
  render();
}
function step(d) { if (S) setView((view ?? S.ply) + d); }
document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => {
  if (!S) return;
  ({ first: () => setView(0), prev: () => step(-1), next: () => step(1), last: () => setView(null) })[b.dataset.nav]();
}));
$('#liveBtn').addEventListener('click', () => setView(null));

// ---------- coach line ----------
function renderCoach(ply) {
  const cls = $('#coachCls'), title = $('#coachTitle'), sub = $('#coachSub'), replay = $('#coachReplay');
  replay.hidden = true;
  if (ply === 0) {
    cls.className = 'cls empty'; cls.style.background = ''; cls.textContent = '♞';
    title.textContent = view === 0 ? 'Starting position' : 'New game';
    sub.textContent = 'You start as White. Drag a piece or ask for a hint.';
    return;
  }
  const i = ply - 1, n = S.notes[i], color = i % 2 === 0 ? 'w' : 'b';
  const who = color === 'w' ? 'You' : 'AI';
  const c = n?.cls ? CLASSES[n.cls] : null;
  if (c) { cls.className = 'cls'; cls.style.background = c.color; cls.textContent = c.sym; }
  else { cls.className = 'cls empty'; cls.style.background = ''; cls.textContent = '…'; }
  title.innerHTML = `${who} played ${fig(S.moves[i], color)}<span class="lbl">· ${c ? esc(c.label) : 'analyzing…'}</span>`;
  const parts = [];
  if (S.status === 'over' && ply === S.ply) parts.push(`${S.result.text}.`);
  if (n?.best && ['good', 'inaccuracy', 'mistake', 'blunder'].includes(n.cls)) parts.push(`Best was ${fig(n.best, color)}.`);
  const m = n?.motifs?.[0];
  if (m) parts.push(esc(m.text));
  if (n?.hint === 'followed') parts.push('Played the Stockfish hint.');
  if (n?.engine === 'followed') parts.push('The AI followed its engine.');
  sub.innerHTML = parts.join(' ') || (n?.cls === 'book' ? 'Book move: it is in the opening books.' : '');
  replay.hidden = !(prefs.tactics && m && view === null);
}
$('#coachReplay').addEventListener('click', () => {
  const n = S?.notes[S.ply - 1];
  if (n?.motifs?.[0]) board.showMotif(n.motifs[0]);
});

// ---------- status ----------
function renderStatus() {
  const chip = $('#turnChip'), text = $('#turnText');
  let state, label;
  if (!online) { state = 'over'; label = 'Server offline'; }
  else if (S.status === 'over') { state = 'over'; label = 'Game over'; }
  else if (busy) { state = 'wait'; label = 'Sending…'; }
  else if (S.turn === 'w') { state = 'player'; label = S.inCheck ? 'Your turn · check!' : 'Your turn'; }
  else { state = 'ai'; label = 'AI thinking'; }
  chip.dataset.state = state;
  text.textContent = label;
  $('#scoreYou').textContent = S.score.player;
  $('#scoreAi').textContent = S.score.ai;
  $('#score').title = `${S.score.draws} ${S.score.draws === 1 ? 'draw' : 'draws'}`;
  document.title = state === 'player' ? '● Your turn · Chess' : 'Chess · you vs AI';
  updateTyping();
}

// ---------- hint ----------
function canHint() { return S && online && S.engine.ready && S.status === 'playing' && S.turn === 'w' && !busy && view === null && !hintBusy; }

function renderHint() {
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.level) === prefs.hintLevel)));
  const btn = $('#hintBtn');
  let label = 'Show hint';
  if (!S.engine.ready) label = 'Loading engine…';
  else if (hintBusy) label = 'Analyzing…';
  else if (S.status === 'over') label = 'Game over';
  else if (view !== null) label = 'Go live to ask for a hint';
  else if (busy) label = 'Sending move…';
  else if (S.turn !== 'w') label = 'Wait for your turn';
  btn.textContent = label;
  btn.disabled = !canHint();
  const n = S.hints.count;
  const shame = $('#hintShame');
  shame.className = 'shame' + (n >= 8 ? ' burning' : n >= 4 ? ' hot' : '');
  shame.querySelector('span').textContent = `${n} ${n === 1 ? 'hint' : 'hints'}`;
  const out = $('#hintOut');
  if (hintMsg) out.textContent = hintMsg;
  else if (hint) out.innerHTML = describeHint(hint);
  else out.textContent = 'Piece shows the piece, Move shows the arrow, and Why explains the idea.';
}

function describeHint(h) {
  const p = h.piece;
  if (h.level === 1) return `Piece: there is a strong move with the <b>${PIECE[p]}</b> on <b>${h.from}</b>. Tap it to see the squares.`;
  const head = `Play ${fig(h.san, 'w')}: the ${PIECE[p]} from <b>${h.from}</b> to <b>${h.to}</b>.`;
  if (h.level === 2) return head;
  return `${head}<ul>${h.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
}

async function requestHint() {
  if (!canHint()) return;
  sound.unlock();
  hintMsg = null;
  if (hint && hint.ply === S.ply && hint.level >= prefs.hintLevel) { hint.level = prefs.hintLevel; render(); return; }
  hintBusy = true;
  renderHint();
  try {
    const h = await api('POST', '/api/hint', { level: prefs.hintLevel });
    if (h.ply === S.ply) { hint = { ...h, level: prefs.hintLevel }; sound.play('hint'); }
  } catch (e) {
    hintMsg = e.message;
  } finally {
    hintBusy = false;
    render();
  }
}
$('#hintBtn').addEventListener('click', requestHint);
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  prefs.hintLevel = Number(b.dataset.level);
  savePrefs();
  if (hint && hint.ply === S?.ply) {
    if (prefs.hintLevel > hint.level) requestHint();
    else { hint.level = prefs.hintLevel; render(); }
  } else renderHint();
}));

// ---------- moves ----------
async function playMove({ from, to, promotion, dragged }) {
  if (busy || !S || S.turn !== 'w' || S.status !== 'playing' || view !== null) return;
  sound.unlock();
  const c = new Chess(S.fens[S.ply]);
  let m;
  try { m = c.move({ from, to, promotion }); } catch { sound.play('illegal'); return; }
  const uci = m.from + m.to + (m.promotion || '');
  busy = true;
  hint = null;
  hintMsg = null;
  // Show it right away; the server confirms next.
  apply({
    ...S, ply: S.ply + 1, turn: 'b', inCheck: c.inCheck(), _dragged: dragged,
    fens: [...S.fens, c.fen()], uci: [...S.uci, uci], moves: [...S.moves, m.san],
    notes: [...S.notes, null], evals: [...S.evals, null],
  });
  try {
    const r = await api('POST', '/api/move', { move: uci, by: 'w' });
    busy = false;
    apply(r);
  } catch (e) {
    busy = false;
    toast(e.message);
    sound.play('illegal');
    try { const s = await api('GET', '/api/state'); S = null; apply(s); } catch {}
  }
}

// ---------- draw, resignation, new game ----------
function armed(btn, label, ms = 3000) {
  if (btn.dataset.armed) { delete btn.dataset.armed; clearTimeout(btn._t); btn.textContent = btn.dataset.label; btn.classList.remove('danger'); return true; }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = label;
  btn.classList.add('danger');
  btn._t = setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn.dataset.label; btn.classList.remove('danger'); }, ms);
  return false;
}

function renderActions() {
  const playing = S.status === 'playing';
  $('#drawBanner').hidden = !(playing && S.drawOffer === 'b');
  const drawBtn = $('#drawBtn'), resignBtn = $('#resignBtn');
  drawBtn.disabled = !playing || S.drawOffer === 'w' || !S.ply;
  if (!drawBtn.dataset.armed) drawBtn.textContent = S.drawOffer === 'w' ? 'Offer sent' : '½ Draw';
  resignBtn.disabled = !playing || !S.ply;
}

$('#drawBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/draw', { by: 'w', action: 'offer' }); toast('Draw offer sent. The AI decides.'); pollState(); } catch (e) { toast(e.message); }
});
$('#drawAccept').addEventListener('click', async () => { try { apply(await api('POST', '/api/draw', { by: 'w', action: 'accept' })); } catch (e) { toast(e.message); } });
$('#drawDecline').addEventListener('click', async () => { try { apply(await api('POST', '/api/draw', { by: 'w', action: 'decline' })); } catch (e) { toast(e.message); } });
$('#resignBtn').addEventListener('click', async (e) => {
  if (!armed(e.currentTarget, 'Confirm?')) return;
  try { apply(await api('POST', '/api/resign', { by: 'w' })); } catch (err) { toast(err.message); }
});
$('#newBtn').addEventListener('click', async (e) => {
  if (S && S.status === 'playing' && S.ply > 0 && !armed(e.currentTarget, 'Give up and restart?')) return;
  await newGame();
});
async function newGame() {
  try { const s = await api('POST', '/api/reset'); closeResult(); apply(s); } catch (e) { toast(e.message); }
}

// ---------- game over ----------
function openResult() {
  if (!S || S.status !== 'over') return;
  const r = S.result;
  const won = r.winner === 'w', lost = r.winner === 'b';
  $('#resultTitle').textContent = won ? 'You win!' : lost ? 'The AI wins' : 'Draw';
  $('#resultReason').textContent = `By ${r.text.split(' by ')[1] || r.reason} · ${Math.ceil(S.ply / 2)} moves`;
  $('#resultPiece').src = `pieces/${won ? 'w' : lost ? 'b' : 'w'}${won || lost ? 'k' : 'q'}.svg`;
  $('#resultMedal').style.background = won ? 'linear-gradient(145deg,#ffd60a,#ff9500)' : lost ? 'linear-gradient(145deg,#d97757,#8944ab)' : 'var(--fill)';
  $('#rsYou').textContent = S.score.player;
  $('#rsAi').textContent = S.score.ai;
  const count = (side, cls) => S.notes.filter((n, i) => n?.cls === cls && (i % 2 === 0) === (side === 'w')).length;
  const rowsHtml = ['brilliant', 'best', 'excellent', 'inaccuracy', 'mistake', 'blunder'].map((k) => {
    const c = CLASSES[k];
    return `<tr><td><span class="mcls" style="background:${c.color};display:inline-grid;vertical-align:-3px;margin-right:6px">${esc(c.sym)}</span>${c.label}</td><td>${count('w', k)}</td><td>${count('b', k)}</td></tr>`;
  }).join('');
  $('#report').innerHTML = `<thead><tr><th></th><th>You</th><th>AI</th></tr></thead><tbody>${rowsHtml}
    <tr><td>Stockfish help</td><td>${S.hints.count}</td><td>${S.assists.count}</td></tr></tbody>`;
  const dlg = $('#resultDlg');
  if (!dlg.open) dlg.showModal();
  sound.play('end');
  if (won) confetti();
}
function closeResult() { const d = $('#resultDlg'); if (d.open) d.close(); }
$('#rematchBtn').addEventListener('click', () => newGame());
$('#reviewBtn').addEventListener('click', () => { closeResult(); setView(0); });
$('#pgnBtn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(S.pgn); toast('PGN copied.'); } catch { toast("Couldn't copy the PGN."); }
});

function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = document.createElement('canvas');
  cv.className = 'confetti';
  document.body.appendChild(cv);
  const dpr = devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const colors = ['#81b64c', '#0071e3', '#ff9500', '#ff3b30', '#ffd60a', '#af52de'];
  const parts = Array.from({ length: 150 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 240, y: innerHeight * 0.38,
    vx: (Math.random() - 0.5) * 15, vy: -Math.random() * 15 - 5,
    w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  const frame = (t) => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.38; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    if (t - t0 < 2800) requestAnimationFrame(frame); else cv.remove();
  };
  requestAnimationFrame(frame);
}

// ---------- chat ----------
let chatLast = 0, chatLoaded = false, bubbleUntil = 0, bubbleTimer = null;
const chatList = $('#chatList');

function addMessages(list) {
  const atBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const m of list) {
    const d = document.createElement('div');
    d.className = 'msg ' + (m.from === 'player' ? 'player' : 'ai');
    d.textContent = m.text;
    if (!chatLoaded) d.style.animation = 'none';
    frag.appendChild(d);
  }
  chatList.appendChild(frag);
  while (chatList.children.length > 160) chatList.firstElementChild.remove();
  if (atBottom || !chatLoaded || list.some((m) => m.from === 'player')) chatList.scrollTop = chatList.scrollHeight;
}

async function pollChat() {
  try {
    const list = await api('GET', `/api/chat?after=${chatLast}`);
    if (list.length) {
      addMessages(list);
      chatLast = list.at(-1).id;
      const mine = list.filter((m) => m.from === 'ai').at(-1);
      if (mine && (chatLoaded || Date.now() - mine.at < 30000)) {
        showBubble(mine.text);
        if (chatLoaded) sound.play('notify');
      }
    }
    chatLoaded = true;
  } catch {}
}

function showBubble(text) {
  const b = rows.ai.querySelector('[data-bubble]');
  b.classList.remove('typing');
  b.textContent = text;
  b.title = text;
  b.classList.toggle('long', text.length > 60);
  b.classList.add('show');
  bubbleUntil = Date.now() + 15000;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { b.classList.remove('show'); bubbleUntil = 0; setTimeout(updateTyping, 300); }, 15000);
}

// While it is the AI's turn and it is not saying anything, the bubble shows "typing".
function updateTyping() {
  if (!rows.ai || Date.now() < bubbleUntil) return;
  const b = rows.ai.querySelector('[data-bubble]');
  const thinking = S && online && S.status === 'playing' && S.turn === 'b' && !busy;
  if (thinking && !b.classList.contains('typing')) {
    b.classList.add('typing', 'show');
    b.title = 'AI is thinking';
    b.innerHTML = '<span class="dots" aria-label="AI is thinking"><i></i><i></i><i></i></span>';
  } else if (!thinking && b.classList.contains('typing')) {
    b.classList.remove('typing', 'show');
  }
}

async function sendChat(text) {
  const t = text.trim();
  if (!t) return false;
  try {
    await api('POST', '/api/chat', { from: 'player', text: t });
    await pollChat();
    return true;
  } catch { toast("Couldn't send the message."); return false; }
}
$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const t = input.value;
  input.value = '';
  if (!(await sendChat(t))) input.value = t;
});
$('#quick').innerHTML = QUICK.map((q) => `<button type="button">${esc(q)}</button>`).join('');
$('#quick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) sendChat(b.textContent); });

// ---------- settings and guide ----------
function applyPrefs() {
  document.documentElement.dataset.board = prefs.board;
  sound.enabled = prefs.sound;
  board.setShowLegal(prefs.legal);
  board.setOrientation(prefs.flip ? 'b' : 'w');
}
$('#settingsBtn').addEventListener('click', () => {
  document.querySelectorAll('[data-pref]').forEach((i) => { i.checked = !!prefs[i.dataset.pref]; });
  document.querySelectorAll('#themes input').forEach((i) => { i.checked = i.value === prefs.board; });
  $('#settingsDlg').showModal();
});
document.querySelectorAll('[data-pref]').forEach((i) => i.addEventListener('change', () => {
  prefs[i.dataset.pref] = i.checked;
  savePrefs();
  applyPrefs();
  if (i.dataset.pref === 'tactics' && !i.checked) board.clearMotif();
  movesKey = '';
  render();
}));
document.querySelectorAll('#themes input').forEach((i) => i.addEventListener('change', () => { prefs.board = i.value; savePrefs(); applyPrefs(); }));
$('#guideBtn').addEventListener('click', () => $('#guideDlg').showModal());
$('#legend').innerHTML = Object.values(CLASSES).map((c) => `<div><span class="mcls" style="background:${c.color}">${esc(c.sym)}</span>${c.label}</div>`).join('');
function flip() {
  prefs.flip = !prefs.flip;
  savePrefs();
  applyPrefs();
  placeRows();
  render();
}
$('#flipBtn').addEventListener('click', flip);
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select') || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'ArrowLeft') { step(-1); e.preventDefault(); }
  else if (k === 'ArrowRight') { step(1); e.preventDefault(); }
  else if (k === 'Home') { setView(0); e.preventDefault(); }
  else if (k === 'End') { setView(null); e.preventDefault(); }
  else if (k === 'f' || k === 'F') flip();
  else if (k === 'h' || k === 'H') requestHint();
  else if (k === 'Escape') board.escape();
});

// ---------- notices ----------
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- start ----------
buildRows();
applyPrefs();
(async function tick() {
  await pollState();
  await pollChat();
  setTimeout(tick, 1000);
})();
