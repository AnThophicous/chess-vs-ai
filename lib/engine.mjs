// Stockfish search queue with priorities. A more important search (the player's hint) interrupts
// a less important one (background evaluation), which returns what it had already calculated.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROC = fileURLToPath(new URL('./engine-proc.cjs', import.meta.url));

export class Engine {
  constructor(name, { hash = 32 } = {}) {
    this.name = name;
    this.hash = hash;
    this.ready = false;
    this.jobs = [];
    this.cur = null;
    this.#start();
  }

  #start() {
    this.ready = false;
    this.startedAt = Date.now();
    const child = fork(PROC, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    this.child = child;
    child.on('message', (line) => { if (child === this.child) this.#onLine(String(line)); });
    child.on('exit', (code) => {
      if (child !== this.child || this.stopping) return;
      console.error(`[engine ${this.name}] exited (code ${code})`);
      this.#restart();
    });
    this.#send('uci');
  }

  #restart() {
    const job = this.cur;
    this.cur = null;
    const old = this.child;
    this.child = null;
    try { old.kill(); } catch {}
    if (job) this.#finish(job, null);
    // Avoid a restart loop if the engine never comes up.
    const wait = Date.now() - this.startedAt < 10000 ? 5000 : 200;
    setTimeout(() => this.#start(), wait);
  }

  #send(cmd) { try { this.child?.connected && this.child.send(cmd); } catch {} }

  /** Shuts the engine process down (when the server stops). */
  close() { this.stopping = true; try { this.child?.kill(); } catch {} }

  #onLine(line) {
    if (line === 'uciok') {
      this.#send(`setoption name Hash value ${this.hash}`);
      this.#send('isready');
    } else if (line === 'readyok') {
      if (!this.ready) { this.ready = true; this.onReady?.(); this.#pump(); }
    } else if (line.startsWith('error ')) {
      console.error(`[engine ${this.name}]`, line);
    } else if (this.cur && line.startsWith('info ') && line.includes(' pv ')) {
      this.#parseInfo(line);
    } else if (this.cur && line.startsWith('bestmove')) {
      const [, best, , ponder] = line.split(' ');
      const job = this.cur;
      this.cur = null;
      this.#finish(job, best && best !== '(none)' ? best : null, ponder);
      this.#pump();
    }
  }

  #parseInfo(line) {
    const tok = line.split(' ');
    const at = (k) => tok.indexOf(k);
    if (at('lowerbound') >= 0 || at('upperbound') >= 0) return;
    const multipv = at('multipv') >= 0 ? Number(tok[at('multipv') + 1]) : 1;
    const depth = Number(tok[at('depth') + 1]);
    const s = at('score');
    if (s < 0) return;
    const kind = tok[s + 1], val = Number(tok[s + 2]);
    const pv = tok.slice(at('pv') + 1);
    this.cur.lines[multipv - 1] = { depth, pv, ...(kind === 'mate' ? { mate: val } : { cp: val }) };
  }

  #finish(job, best, ponder) {
    clearTimeout(job.timer);
    const lines = job.lines.filter(Boolean);
    job.resolve({ best: best || lines[0]?.pv?.[0] || null, ponder: ponder || null, lines, depth: lines[0]?.depth || 0 });
  }

  #pump() {
    if (!this.ready || this.cur || !this.jobs.length) return;
    const job = this.jobs.shift();
    this.cur = job;
    this.#send(`setoption name MultiPV value ${job.multipv}`);
    this.#send(`position fen ${job.fen}`);
    const go = ['go'];
    if (job.depth) go.push('depth', job.depth);
    if (job.movetime) go.push('movetime', job.movetime);
    this.#send(go.join(' '));
    // If the engine does not answer, restart it instead of leaving the queue stuck.
    job.timer = setTimeout(() => {
      this.#send('stop');
      job.timer = setTimeout(() => { console.error(`[engine ${this.name}] stalled, restarting`); this.#restart(); }, 5000);
    }, (job.movetime || 20000) + 8000);
  }

  /**
   * Searches a position. Scores come from the point of view of the side to move in the FEN.
   * @returns {Promise<{best, ponder, lines:[{depth, cp?, mate?, pv}], depth}>}
   */
  search(fen, { depth, movetime, multipv = 1, priority = 0 } = {}) {
    return new Promise((resolve) => {
      const job = { fen, depth, movetime, multipv, priority, resolve, lines: [] };
      const i = this.jobs.findIndex((j) => j.priority < priority);
      if (i < 0) this.jobs.push(job); else this.jobs.splice(i, 0, job);
      if (this.cur && priority > this.cur.priority) this.#send('stop');
      this.#pump();
    });
  }

  /** Drops queued searches that have not started yet (e.g. on a new game). */
  clearQueue(filter = () => true) {
    const keep = [];
    for (const j of this.jobs) (filter(j) ? j.resolve({ best: null, lines: [], depth: 0, cancelled: true }) : keep.push(j));
    this.jobs = keep;
  }
}
