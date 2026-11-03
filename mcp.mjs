#!/usr/bin/env node
// MCP server (stdio) so ANY AI with tool support can play Black: see the game, take a board photo,
// ask the mini-Stockfish advisor, play, talk, and wait for the player's move.
// It talks to the game server (server.mjs), which must be running.
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { turnKey, nextState, turnSummary, endSummary } from './lib/turn.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.CHESS_URL || 'http://localhost:8765').replace(/\/$/, '');
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `You are the AI playing BLACK against the human player (White) in a local chess UI.
Each move, in two steps: wait_for_player (returns when it is your turn, with the player's move, its
classification, the hint they asked for, their chat, and the mini-Stockfish candidates) -> play_move {move, text}.
During a game you speak ONLY through the text argument of play_move. Hints and chat from the player are answered on your next move.
Use the mini-Stockfish as an advisor: pick among its candidates with personality, but never ignore the threats against you.
Persona and rules for the taunts: ${path.join(ROOT, 'prompts', 'taunts.md')} (read it before your first message).`;

// ---------- HTTP ----------
async function api(method, route, body) {
  let res;
  try {
    res = await fetch(BASE + route, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`The game server is down at ${BASE}. Start it with: node ${path.join(ROOT, 'server.mjs')}`);
  }
  if ((res.headers.get('content-type') || '').startsWith('image/')) return Buffer.from(await res.arrayBuffer());
  const data = await res.json();
  if (!res.ok) {
    const legal = data.legal ? `\nLegal moves: ${data.legal.join(' ')}` : '';
    throw new Error((data.error || `HTTP ${res.status}`) + legal);
  }
  return data;
}
const get = (route) => api('GET', route);

// ---------- formatting ----------
function numbered(moves) {
  const out = [];
  for (let i = 0; i < moves.length; i += 2) out.push(`${i / 2 + 1}. ${moves[i]}${moves[i + 1] ? ' ' + moves[i + 1] : ''}`);
  return out.join(' ');
}
function evalText(ev) {
  if (!ev) return 'calculating…';
  if (ev.mate !== undefined && ev.mate !== null) return ev.mate === 0 ? 'game over' : `mate in ${Math.abs(ev.mate)} for ${ev.mate > 0 ? 'White' : 'Black'}`;
  const v = ev.cp / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} (${Math.abs(v) < 0.5 ? 'equal' : v > 0 ? 'White better' : 'Black better'})`;
}
function noteText(st, i) {
  const n = st.notes[i];
  if (!n) return '';
  const who = i % 2 === 0 ? 'White' : 'Black';
  const parts = [`${Math.floor(i / 2) + 1}${i % 2 ? '…' : '.'} ${st.moves[i]} (${who})`];
  parts.push(n.label ? n.label : 'classification pending');
  if (n.best) parts.push(`best was ${n.best}`);
  if (n.motifs.length) parts.push(n.motifs.map((m) => m.text).join(' '));
  if (n.hint) parts.push(n.hint === 'followed' ? 'PLAYED THE STOCKFISH HINT MOVE' : 'had asked for a hint');
  return parts.join(' · ');
}

async function stateText({ pgn = false } = {}) {
  const st = await get('/api/state');
  const chat = await get('/api/chat');
  const lines = [];
  const turnName = st.turn === 'w' ? 'White (player)' : 'Black (you, the AI)';
  lines.push(st.status === 'over' ? `Game #${st.id} is over: ${st.result.text}.` : `Game #${st.id} · ${turnName} to move · move ${Math.floor(st.ply / 2) + 1}${st.inCheck ? ' · IN CHECK' : ''}`);
  lines.push(`Score: player ${st.score.player} × ${st.score.ai} ai (draws ${st.score.draws})`);
  if (st.opening) lines.push(`Opening: ${st.opening.name}`);
  lines.push(`Evaluation: ${evalText(st.evals[st.ply])}`);
  const d = st.material.diff;
  lines.push(`Material: ${d === 0 ? 'equal' : d > 0 ? `White +${d}` : `Black +${-d}`} · White captured [${st.material.byWhite.join(' ') || '-'}] · Black captured [${st.material.byBlack.join(' ') || '-'}]`);
  if (st.ply) lines.push(`Last move: ${noteText(st, st.ply - 1)}`);
  if (st.ply > 1) lines.push(`Previous: ${noteText(st, st.ply - 2)}`);
  const hints = st.hints.list.map((h) => `move ${Math.floor(h.ply / 2) + 1} (${['', 'Piece', 'Move', 'Why'][h.level]} → ${h.san})`);
  lines.push(`Stockfish hints used by the player: ${st.hints.count}${hints.length ? ' · ' + hints.join(', ') : ''}`);
  lines.push(`Your engine consultations: ${st.assists.count}`);
  if (st.drawOffer) lines.push(`Draw offer pending from ${st.drawOffer === 'w' ? 'White (player)' : 'Black (you)'}.`);
  lines.push(`FEN: ${st.fen}`);
  lines.push(`Moves: ${numbered(st.moves) || '(none)'}`);
  const bad = st.notes.map((n, i) => ({ n, i })).filter(({ n }) => ['blunder', 'mistake'].includes(n?.cls));
  if (bad.length) lines.push(`Errors in this game: ${bad.map(({ n, i }) => `${st.moves[i]} (${i % 2 ? 'AI' : 'player'}, ${n.label})`).join(', ')}`);
  const recent = chat.slice(-8).map((m) => `${m.from === 'player' ? 'Player' : 'AI'}: ${m.text}`);
  if (recent.length) lines.push('Recent chat:\n' + recent.join('\n'));
  if (pgn) lines.push('\nPGN:\n' + st.pgn);
  return lines.join('\n');
}

function analysisText(a) {
  if (a.ended) return `Game is over: ${a.result}.`;
  const lines = [`${a.toMove} to move · move ${a.moveNumber}${a.opening ? ' · ' + a.opening : ''}`, `Evaluation: ${a.evalWhite} (White's view) · ${a.evalForMover} (for the side to move)`, '', 'Best moves:'];
  for (const m of a.bestMoves) lines.push(`${m.rank}. ${m.san} (${m.uci}) · ${m.evalForMover} for the side to move · depth ${m.depth} · line: ${m.line}${m.tactics.length ? ' · ' + m.tactics.join(' ') : ''}`);
  lines.push('', 'Threats against the side to move:', ...(a.threatsAgainstMover.length ? a.threatsAgainstMover.map((t) => '- ' + t) : ['- no loose pieces']));
  if (a.ifMoverPassed) lines.push(`If the side to move passed, the opponent would play ${a.ifMoverPassed.move}${a.ifMoverPassed.tactics.length ? ' (' + a.ifMoverPassed.tactics.join(' ') + ')' : ''}.`);
  const u = a.lastOpponentMove;
  if (u) {
    lines.push('', `Opponent's last move: ${u.san} · ${u.label}${u.bestWas ? ' · best was ' + u.bestWas : ''}${u.tactics.length ? ' · ' + u.tactics.join(' ') : ''}`);
    if (u.askedHint) lines.push(u.followedHint ? 'They played exactly the Stockfish hint move.' : 'They asked for a hint on this move but did not follow it.');
  }
  lines.push(`Hints by the player: ${a.hintsByPlayer} · your engine consultations: ${a.engineConsultsByAI}`);
  return lines.join('\n');
}

/** Text version of a "your turn" summary (the same content the watcher prints). */
function turnText(s) {
  const L = [`It is your turn · game #${s.game} · move ${s.moveNumber}${s.inCheck ? ' · YOU ARE IN CHECK' : ''}`];
  const j = s.playerMove;
  if (j) {
    L.push(`Player's move: ${j.move} · ${j.label}${j.bestWas ? ' · best was ' + j.bestWas : ''}${j.tactics.length ? ' · ' + j.tactics.join(' ') : ''}`);
    if (j.hint) L.push(j.followedHint ? `They asked for a hint (${j.hint}) and PLAYED THE STOCKFISH MOVE.` : `They asked for a hint (${j.hint}) and played something else.`);
  }
  L.push(`Hints in this game: ${s.hintsInGame} · ${s.score}${s.opening ? ' · ' + s.opening : ''}`);
  if (s.chat.length) L.push('Player chat since your last message:\n' + s.chat.map((t) => `- ${t}`).join('\n'));
  if (s.drawOffered) L.push('The player OFFERED A DRAW: answer with the draw tool (or ignore it by playing on).');
  L.push('', `Mini-Stockfish (eval for you: ${s.evalForMover ?? '…'}):`);
  s.candidates.forEach((c, k) => L.push(`${k + 1}. ${c.move} (${c.uci}) · ${c.evalForMover} · ${c.line}${c.tactics.length ? ' · ' + c.tactics.join(' ') : ''}`));
  if (s.analysisError) L.push(`(analysis failed: ${s.analysisError})`);
  L.push('Threats against you: ' + (s.threats.length ? s.threats.join(' ') : 'none'));
  if (s.ifYouPassed) L.push(`If you passed: ${s.ifYouPassed.move}${s.ifYouPassed.tactics.length ? ' (' + s.ifYouPassed.tactics.join(' ') + ')' : ''}`);
  L.push(`FEN: ${s.fen}`);
  return L.join('\n');
}

// ---------- tools ----------
const TOOLS = [
  {
    name: 'get_game_state',
    description: 'Full view of the game: every move (numbered SAN), FEN, side to move, evaluation, material, opening, the last moves\' classification, the Stockfish hints the player used, draw offers, score and recent chat.',
    inputSchema: { type: 'object', properties: { pgn: { type: 'boolean', description: 'Include the full PGN.' } } },
    run: async (a) => [{ type: 'text', text: await stateText(a) }],
  },
  {
    name: 'get_board_image',
    description: 'PNG photo of the board so you can analyze it visually: last move highlighted, check, the move-classification badge and the main tactic arrows. With suggestions=true it draws the 3 best moves from the mini-Stockfish (counts as an engine consultation).',
    inputSchema: {
      type: 'object',
      properties: {
        side: { type: 'string', enum: ['white', 'black'], description: 'Point of view. Default: black (your side).' },
        suggestions: { type: 'boolean', description: 'Draw arrows for the best moves.' },
        ply: { type: 'integer', description: 'Half-move to review (0 = start). Default: current position.' },
      },
    },
    run: async (a) => {
      const q = new URLSearchParams({ orient: a.side === 'white' ? 'w' : 'b' });
      if (Number.isInteger(a.ply)) q.set('ply', a.ply);
      let caption = '';
      if (a.suggestions) {
        const an = await get('/api/analysis?by=ai&lines=3&depth=12');
        if (!an.ended) {
          q.set('arrows', an.bestMoves.map((m, i) => `${m.uci}:${i === 0 ? 'best' : 'alt'}`).join(','));
          caption = 'Green arrows: ' + an.bestMoves.map((m) => `${m.rank}. ${m.san} (${m.evalForMover})`).join(', ');
        }
      }
      const png = await api('GET', '/api/board.png?' + q);
      return [
        { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: caption || 'Orange arrows: the tactic of the last move. Badge in the corner: classification of the move.' },
      ];
    },
  },
  {
    name: 'get_engine_analysis',
    description: 'The mini-Stockfish advisor: best moves for the side to move (evaluation, main line, tactics of each move), threats against you, and the classification of the opponent\'s last move (with what it should have been). Counts as an engine consultation and is visible to the player.',
    inputSchema: {
      type: 'object',
      properties: {
        depth: { type: 'integer', minimum: 6, maximum: 20, description: 'Search depth. Default 12.' },
        lines: { type: 'integer', minimum: 1, maximum: 5, description: 'How many moves to list. Default 3.' },
      },
    },
    run: async (a) => {
      const q = new URLSearchParams({ by: 'ai', depth: a.depth ?? 12, lines: a.lines ?? 3 });
      return [{ type: 'text', text: analysisText(await get('/api/analysis?' + q)) }];
    },
  },
  {
    name: 'play_move',
    description: 'Play your Black move AND say something in the same call (during a game this is the only way to speak). Accepts SAN (Nf6, exd5, O-O, e1=N) or UCI (g8f6, e2e1n). Promotion piece is your choice.',
    inputSchema: {
      type: 'object',
      properties: {
        move: { type: 'string' },
        text: { type: 'string', description: 'What you say. Follow prompts/taunts.md. Up to 160 characters.' },
      },
      required: ['move'],
    },
    run: async (a) => {
      const r = await api('POST', '/api/move', { move: a.move, by: 'b', text: a.text });
      const lines = [`You played ${r.played}.${a.text ? ' Message sent.' : ''}`];
      if (r.motifs?.length) lines.push('Tactics: ' + r.motifs.map((m) => m.text).join(' '));
      lines.push(r.status === 'over' ? `Game over: ${r.result.text}.` : `Now it is White's turn${r.inCheck ? ' (in check)' : ''}.`);
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  {
    name: 'say_after_game',
    description: 'Send a chat message. Only allowed when the game is over (a goodbye, a rematch offer). During a game, speak with play_move.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async (a) => { await api('POST', '/api/chat', { from: 'ai', text: a.text }); return [{ type: 'text', text: 'Message sent.' }]; },
  },
  {
    name: 'wait_for_player',
    description: 'Waits until it is your turn and returns everything needed to play and talk: the player\'s move (classification, tactics, the hint they asked for), their chat since your last message, and the mini-Stockfish candidates (this counts as an engine consultation). Returns at once if it is already your turn. Also returns when the game ends or the player offers a draw.',
    inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'integer', minimum: 5, maximum: 600, description: 'Default 120.' } } },
    run: async (a) => {
      const deadline = Date.now() + Math.min(600, Math.max(5, a.timeout_seconds ?? 120)) * 1000;
      let st = await get('/api/state');
      const startedOver = st.status === 'over';
      for (;;) {
        if (turnKey(st)) {
          const s = await turnSummary(get, st);
          if (s) return [{ type: 'text', text: turnText(s) }];
        } else if (st.status === 'over' && !startedOver) {
          const e = endSummary(st);
          return [{ type: 'text', text: `Game over: ${e.result}. Last move: ${e.lastMove}. ${e.score}. Hints used by the player: ${e.hintsInGame}.` }];
        } else if (st.status === 'playing' && st.drawOffer === 'w') {
          return [{ type: 'text', text: 'The player offered a draw. Answer with the draw tool (you can send text with it).' }];
        }
        const left = (deadline - Date.now()) / 1000;
        if (left <= 0) {
          return [{ type: 'text', text: st.status === 'over' ? `Game over (${st.result.text}). Waiting for the player to start a new game.` : 'Nothing yet: it is White\'s turn and the player has not moved.' }];
        }
        st = (await nextState(get, st.v, Math.min(25, left))) || st;
      }
    },
  },
  {
    name: 'resign',
    description: 'You (Black) give up the game. Use only when you are really lost.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Last words (optional).' } } },
    run: async (a) => { const st = await api('POST', '/api/resign', { by: 'b', text: a.text }); return [{ type: 'text', text: st.result.text }]; },
  },
  {
    name: 'draw',
    description: 'Offer, accept or decline a draw (optionally with a message).',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['offer', 'accept', 'decline'] }, text: { type: 'string' } },
      required: ['action'],
    },
    run: async (a) => {
      const st = await api('POST', '/api/draw', { by: 'b', action: a.action, text: a.text });
      return [{ type: 'text', text: st.result ? st.result.text : st.drawOffer ? 'Draw offer sent.' : 'Draw offer declined.' }];
    },
  },
  {
    name: 'new_game',
    description: 'Start a new game. Only when the player asks for a rematch.',
    inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] },
    run: async (a) => {
      if (!a.confirm) return [{ type: 'text', text: 'Nothing done (confirm=false).' }];
      await api('POST', '/api/reset');
      return [{ type: 'text', text: 'New game created. White starts.' }];
    },
  },
];

// ---------- JSON-RPC over stdio ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'chess-vs-ai', version: '3.0.0' },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${msg.params?.name}`), { code: -32602 });
      try {
        return { content: await tool.run(msg.params.arguments || {}) };
      } catch (err) {
        return { content: [{ type: 'text', text: String(err.message || err) }], isError: true };
      }
    }
    case 'resources/list': return { resources: [] };
    case 'prompts/list': return { prompts: [] };
    default:
      if (msg.id === undefined) return undefined; // notifications get no reply
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
  }
}

// Keep the process alive until every pending call has answered, even after stdin closes.
let pending = 0, closed = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  pending++;
  Promise.resolve()
    .then(() => handle(msg))
    .then((result) => { if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result }); })
    .catch((err) => {
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32000, message: String(err.message || err) } });
    })
    .finally(() => { pending--; if (closed && pending === 0) process.exit(0); });
});
rl.on('close', () => { closed = true; if (pending === 0) process.exit(0); });
