#!/usr/bin/env node
// The AI plays Black and talks in one command (during a game, the AI can only speak with a move).
//   node play.mjs <move> ["<text>"]                    e.g.  node play.mjs g8f6 "Ok. Predictable."
//   node play.mjs --draw <accept|decline|offer> ["<text>"]
//   node play.mjs --resign ["<text>"]
//   node play.mjs --say "<text>"                       only when the game is over
// Moves accept UCI (g8f6, e2e1n) or SAN (Nf6, O-O, e1=N).
const BASE = (process.env.CHESS_URL || 'http://localhost:8765').replace(/\/$/, '');

async function post(route, body) {
  let res;
  try {
    res = await fetch(BASE + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error(`The game server is down at ${BASE}.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error || `HTTP ${res.status}`) + (data.legal ? `\nLegal moves: ${data.legal.join(' ')}` : ''));
  return data;
}

const [cmd, ...rest] = process.argv.slice(2);
const after = (st) => (st.status === 'over' ? `${st.result.text}.` : `${st.turn === 'w' ? 'White' : 'Black'} to move${st.inCheck ? ' (in check)' : ''}.`);

try {
  if (!cmd) throw new Error('Usage: node play.mjs <move> ["<text>"] | --draw <accept|decline|offer> ["<text>"] | --resign ["<text>"] | --say "<text>"');
  if (cmd === '--draw') {
    const action = { accept: 'accept', decline: 'decline', offer: 'offer' }[rest[0]];
    if (!action) throw new Error('Use --draw accept, decline or offer.');
    const st = await post('/api/draw', { by: 'b', action, text: rest.slice(1).join(' ') });
    console.log(`Draw ${rest[0]}. ${after(st)}`);
  } else if (cmd === '--resign') {
    const st = await post('/api/resign', { by: 'b', text: rest.join(' ') });
    console.log(after(st));
  } else if (cmd === '--say') {
    await post('/api/chat', { from: 'ai', text: rest.join(' ') });
    console.log('Message sent.');
  } else {
    const text = rest.join(' ').trim();
    const st = await post('/api/move', { move: cmd, by: 'b', text });
    const tac = st.motifs?.length ? ` Tactics: ${st.motifs.map((m) => m.text).join(' ')}` : '';
    console.log(`Played ${st.played}. ${after(st)}${text ? ' Message sent.' : ''}${tac}`);
  }
} catch (err) {
  console.error(String(err.message || err));
  process.exit(1);
}
