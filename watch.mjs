#!/usr/bin/env node
// Watcher for the Claude Code Monitor tool (or any agent that reads stdout). It prints ONE JSON line
// whenever the AI needs to act, and keeps running:
//   your_turn       it is Black's turn: the player's move (classification, tactics, hint), the chat since the
//                   AI's last message, and the mini-Stockfish analysis (candidates, threats). Play right away.
//   reminder        still Black's turn and nobody has moved (40 s, 2 min, 5 min, then every 10 min)
//   draw_offered    the player offered a draw on their turn
//   end             the game is over (mate, resignation, draw)
//   server_down / server_up
//
// It works by STATE, not by events: on every change of the state (long-poll on /api/state) it asks
// "is it Black's turn on a move I have not announced yet?". If the watcher restarts, it announces
// the pending turn again, which is what you want.
// Only one watcher runs at a time: a new one ends the previous one (.watch.pid).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGet, turnKey, nextState, turnSummary, endSummary } from './lib/turn.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.CHESS_URL || 'http://localhost:8765').replace(/\/$/, '');
const DIR = process.env.CHESS_WATCH_DIR || ROOT;
const PIDFILE = path.join(DIR, '.watch.pid');
const STATEFILE = path.join(DIR, '.watch_state.json');
const REMIND = (process.env.CHESS_REMINDERS ?? '40,120,300').split(',').map(Number).filter((n) => n > 0);
const REMIND_EVERY = Number(process.env.CHESS_REMINDER_EVERY || 600);

const get = makeGet(BASE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

// ---------- one watcher only ----------
try {
  const old = Number(fs.readFileSync(PIDFILE, 'utf8'));
  if (old && old !== process.pid && fs.readFileSync(`/proc/${old}/cmdline`, 'utf8').includes('watch.mjs')) process.kill(old, 'SIGTERM');
} catch {}
fs.writeFileSync(PIDFILE, String(process.pid));
process.on('exit', () => { try { if (Number(fs.readFileSync(PIDFILE, 'utf8')) === process.pid) fs.unlinkSync(PIDFILE); } catch {} });
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => process.exit(0));

// ---------- watcher state ----------
const saved = readJson(STATEFILE, null);
let endAnnounced = saved?.end ?? null;   // last game whose end was announced (survives restarts)
let turn = null;                          // { key, at, n } announced turn (memory only, on purpose)
let drawSeen = null;                      // draw offer already announced
let last = null;                          // last state seen
let v = null;
let booted = false;                       // has the first state been processed?
let downSince = null, downWarned = false;

const saveState = () => { try { fs.writeFileSync(STATEFILE, JSON.stringify({ end: endAnnounced })); } catch {} };
const due = (n) => (n < REMIND.length ? REMIND[n] : REMIND.at(-1) + REMIND_EVERY * (n - REMIND.length + 1)) * 1000;

for (;;) {
  // How long to wait: until the next state change, or until the next reminder is due.
  let waitS = 20;
  if (turn && REMIND.length) waitS = Math.min(20, Math.max(0.5, (turn.at + due(turn.n) - Date.now()) / 1000));

  let st;
  try {
    st = await nextState(get, v, waitS);
    if (downWarned) out({ event: 'server_up' });
    downSince = null; downWarned = false;
  } catch {
    downSince ??= Date.now();
    if (!downWarned && Date.now() - downSince > 8000) { out({ event: 'server_down', url: BASE }); downWarned = true; }
    v = null; // a restarted server starts its version from zero: fetch the full state when it is back
    await sleep(1500);
    continue;
  }
  if (st) { v = st.v; last = st; } else st = last;
  if (!st) continue;
  const firstLook = !booted;
  booted = true;

  // ----- end of game -----
  if (st.status === 'over') {
    turn = null;
    // Watcher started with the game already over: it is an old game, do not announce it.
    if (firstLook && saved === null) { endAnnounced = st.id; saveState(); }
    if (endAnnounced !== st.id) { endAnnounced = st.id; saveState(); out(endSummary(st)); }
    continue;
  }

  // ----- the AI's turn -----
  const key = turnKey(st);
  if (!key) {
    turn = null;
    const dk = `${st.id}:${st.ply}`;
    if (st.drawOffer === 'w' && drawSeen !== dk) { drawSeen = dk; out({ event: 'draw_offered', game: st.id, moveNumber: Math.floor(st.ply / 2) + 1, turn: 'white' }); }
    continue;
  }
  if (turn?.key !== key) {
    let s = null;
    try { s = await turnSummary(get, st); } catch {}
    if (!s) { v = null; continue; } // the position changed (or the server dropped) in the middle: look again
    if (s.drawOffered) drawSeen = key;
    out(s);
    turn = { key, at: Date.now(), n: 0 };
    continue;
  }
  if (REMIND.length && Date.now() - turn.at >= due(turn.n)) {
    turn.n++;
    out({ event: 'reminder', game: st.id, lastMove: st.moves.at(-1), waitingFor: `${Math.round((Date.now() - turn.at) / 1000)} s`, fen: st.fen });
  }
  if (st.drawOffer === 'w' && drawSeen !== key) { drawSeen = key; out({ event: 'draw_offered', game: st.id, moveNumber: Math.floor(st.ply / 2) + 1, turn: 'black' }); }
}
