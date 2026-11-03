// Child process that runs Stockfish 16 (WASM, NNUE, one thread) and speaks UCI with the server
// over the IPC channel. It lives outside the server process so a search never blocks HTTP.
// (This build does not load inside worker_threads: there it behaves as an internal thread.)
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'node_modules', 'stockfish', 'src') + path.sep;
const BUILD = 'stockfish-nnue-16-single';
const pending = [];
let engine = null;
// If the server dies in the middle of a search, the channel closes: exit quietly instead of EPIPE.
const send = (line) => { if (process.connected) process.send(line, () => {}); };

require(DIR + BUILD + '.js')()({ locateFile: (f) => DIR + (f.endsWith('.wasm') ? BUILD + '.wasm' : f) })
  .then((sf) => {
    engine = sf;
    sf.addMessageListener((line) => send(String(line)));
    for (const cmd of pending.splice(0)) sf.onCustomMessage(cmd);
  })
  .catch((err) => { send('error ' + (err && err.message ? err.message : String(err))); process.exit(1); });

process.on('message', (cmd) => (engine ? engine.onCustomMessage(String(cmd)) : pending.push(String(cmd))));
process.on('disconnect', () => process.exit(0));
process.on('error', () => process.exit(0));
