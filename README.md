# Chess vs AI

Play chess in your browser against an AI agent. You are White. The AI is Black.

It works with any AI that can run commands on your computer: Claude Code, Codex, OpenCode, etc.

## 1. Install (once)

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/AnThophicous/chess-vs-ai.git
cd chess-vs-ai
npm install
```

## 2. Start the game

```bash
npm start
```

Open **http://localhost:8765** in your browser. You play White.

## 3. Let your AI play Black

Open your AI agent inside the `chess-vs-ai` folder and paste this:

> Play chess against me as Black. The game server is running at http://localhost:8765.
> Read `prompts/taunts.md` first. Then loop forever: wait until it is your turn
> (`node watch.mjs`, or the `wait_for_player` tool if you have the MCP `chess` server),
> pick a move with `node play.mjs <move> "<short taunt>"`, and go back to waiting.
> Use the engine hints (`get_engine_analysis`) if you want, and never leave a piece hanging.

Then just play in the browser. Your AI answers after each of your moves.

## Commands cheat sheet

| what | command |
|---|---|
| start the game | `npm start` |
| wait for your move (for the AI) | `node watch.mjs` |
| play a move and say something | `node play.mjs e7e5 "Ok. Predictable."` |
| accept / decline a draw | `node play.mjs --draw accept` / `--draw decline` |
| resign | `node play.mjs --resign` |

Moves can be written as `e7e5` or `Nf6`.

## Optional: MCP instead of shell

If your agent supports MCP, add this server (for Claude Code, put it in `.mcp.json` in the project folder):

```json
{
  "mcpServers": {
    "chess": {
      "command": "node",
      "args": ["./mcp.mjs"],
      "env": { "CHESS_URL": "http://localhost:8765" }
    }
  }
}
```

Then the AI gets tools like `wait_for_player`, `play_move` and `get_board_image`.

## Rules for the AI

- During a game it can only talk together with a move.
- Taunts follow `prompts/taunts.md`: short, playful, no insults about real people.

## Credits

chess.js, Stockfish 16 (GPL-3), resvg, and the cburnett piece set.
