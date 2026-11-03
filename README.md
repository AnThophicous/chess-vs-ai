# Chess vs AI

Play chess in your browser against an AI agent. You play White. The AI plays Black through any
tool that can run a command: Claude Code, Codex, OpenCode, or any other agent with MCP support or
shell access.

- Stockfish 16 runs on your machine: it powers your hints and the AI's "mini-Stockfish" advisor.
- Every move is classified (Brilliant, Best move, Excellent, Good, Book, Inaccuracy, Mistake, Blunder).
- Tactics are detected and drawn on the board: forks, pins, skewers, hanging pieces, checks, mate threats.
- The AI can see the whole game as text or as a PNG photo of the board, and talks with you in the chat.

## Quick start

```bash
npm install
npm start                       # http://localhost:8765
```

Open the page. You are White. Make a move, and the AI answers through the tools below.

## How an AI plays

There are two ways. Pick whichever your agent supports.

### 1. MCP server (recommended)

`mcp.mjs` is an MCP server over stdio. Point any MCP-capable client at it:

```json
{
  "mcpServers": {
    "chess": {
      "command": "node",
      "args": ["/absolute/path/to/chess-vs-ai/mcp.mjs"],
      "env": { "CHESS_URL": "http://localhost:8765" }
    }
  }
}
```

For Claude Code, save that as `.mcp.json` in the project folder, restart the session and approve the
server in `/mcp`.

Tools:

| tool | what it does |
|---|---|
| `get_game_state` | all moves, FEN, evaluation, material, opening, hints used, chat, score |
| `get_board_image` | PNG of the board, optionally with the 3 best moves drawn as arrows |
| `get_engine_analysis` | the mini-Stockfish advisor: best moves, threats against you, the player's last move |
| `wait_for_player` | blocks until it is your turn, then returns the player's move, their chat and the candidates |
| `play_move` | plays your move and says something in the same call |
| `say_after_game` | chat message, only after the game is over |
| `resign`, `draw`, `new_game` | the usual actions |

The loop is: `wait_for_player` → decide → `play_move`.

### 2. Shell only (any agent that can run commands)

Use `play.mjs` to move and speak, and `watch.mjs` to be woken up when it is your turn.

```bash
node play.mjs g8f6 "Ok. Predictable."                # move + message
node play.mjs --draw accept "Fine."                  # answer a draw offer
node play.mjs --resign "Well played."
```

`watch.mjs` prints one JSON line per event: `your_turn` (with everything needed to move),
`reminder`, `draw_offered`, `end`, `server_down`, `server_up`. Run it in a background process or a
monitor tool that delivers each stdout line to the agent.

## Rules for the AI

- Read `prompts/taunts.md` before the first message. It defines the persona and the limits.
- During a game the AI speaks only together with a move. The server refuses other messages with 409.
- The AI may consult the mini-Stockfish as often as it likes. Every consultation is visible in the
  player's UI.
- Mate, resignation and draws end the game and update the score.

## Project map

| file | role |
|---|---|
| `server.mjs` | HTTP API, long-poll on `/api/state`, board PNG, background evaluation |
| `lib/game.mjs` | game state, events, chat, score, history (JSON files in the data folder) |
| `lib/turn.mjs` | "is it the AI's turn?" and the summary the AI receives |
| `lib/engine.mjs`, `lib/engine-proc.cjs` | Stockfish 16 NNUE (WASM) in a child process, priority queue |
| `lib/tactics.mjs` | tactic detector (forks, pins, skewers, hanging pieces, checks, mate threats) |
| `lib/openings.mjs` | opening book, matched by position (transpositions included) |
| `lib/render.mjs` | SVG to PNG (resvg) for `get_board_image` |
| `mcp.mjs` | MCP server |
| `watch.mjs` | event watcher |
| `play.mjs` | one-command move and message |
| `public/js/review.js` | move classification (shared by server and browser) |
| `public/js/geometry.js` | where each piece can go (the player's arrows follow it) |
| `public/js/app.js`, `board.js`, `sound.js`, `public/css/app.css`, `public/index.html` | the interface |
| `prompts/taunts.md` | persona and rules for the AI's messages |

## Configuration

| variable | default | meaning |
|---|---|---|
| `PORT` | `8765` | server port |
| `DATA_DIR` | project folder | where game, chat, events and history JSON files live |
| `CHESS_URL` | `http://localhost:8765` | where the MCP server, `play.mjs` and `watch.mjs` find the game |
| `CHESS_WATCH_DIR` | project folder | where the watcher keeps its pid and state files |
| `CHESS_REMINDERS` | `40,120,300` | seconds before reminders while the AI is waiting (comma-separated) |
| `CHESS_REMINDER_EVERY` | `600` | seconds between reminders after the list above |

## Notes

- `chess.js` throws on illegal moves: the code always goes through `tryMove` / `parseMove`.
- Stockfish WASM does not run inside `worker_threads`: it runs in a child process.
- Stop the server by PID, not by name (a pattern kill can kill the shell that started it).
- Credits: chess.js, Stockfish 16 (GPL-3), chessground's cburnett piece set (GPL), resvg.
