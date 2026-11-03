// Synthesized sounds, generated on the fly (no files): a wooden tap for moves, chords for events.
export class Sound {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.ctx = null;
    this.noise = null;
  }

  /** Browsers only allow audio after a user gesture. */
  unlock() {
    try {
      this.ctx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {}
  }

  #noiseBuffer() {
    if (this.noise) return this.noise;
    const len = Math.floor(this.ctx.sampleRate * 0.08);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    this.noise = buf;
    return buf;
  }

  // Short wooden tap: filtered noise plus a low "body".
  #tap(t, { freq = 1800, q = 1.3, gain = 0.45, body = 160 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.#noiseBuffer();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t); src.stop(t + 0.1);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(body, t);
    o.frequency.exponentialRampToValueAtTime(body * 0.6, t + 0.08);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(gain * 0.55, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g2).connect(ctx.destination);
    o.start(t); o.stop(t + 0.12);
  }

  #tone(t, freq, dur, gain, type = 'sine') {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }

  play(kind) {
    if (!this.enabled || !this.ctx || this.ctx.state !== 'running') return;
    try {
      const t = this.ctx.currentTime + 0.005;
      switch (kind) {
        case 'move': this.#tap(t); break;
        case 'capture': this.#tap(t, { freq: 1150, gain: 0.65, body: 115 }); this.#tap(t + 0.03, { freq: 2400, gain: 0.2 }); break;
        case 'castle': this.#tap(t); this.#tap(t + 0.1, { freq: 1500 }); break;
        case 'check': this.#tap(t); this.#tone(t + 0.02, 988, 0.13, 0.07); this.#tone(t + 0.09, 1319, 0.16, 0.05); break;
        case 'promote': [523, 659, 784, 1047].forEach((f, i) => this.#tone(t + i * 0.06, f, 0.18, 0.06)); break;
        case 'end': [392, 523, 659, 784].forEach((f, i) => this.#tone(t + i * 0.04, f, 0.7, 0.05, 'triangle')); break;
        case 'start': this.#tone(t, 660, 0.1, 0.05); this.#tone(t + 0.1, 880, 0.14, 0.05); break;
        case 'illegal': this.#tone(t, 160, 0.12, 0.06, 'square'); break;
        case 'notify': this.#tone(t, 740, 0.08, 0.04); this.#tone(t + 0.06, 1109, 0.12, 0.035); break;
        case 'hint': this.#tone(t, 1175, 0.1, 0.045); this.#tone(t + 0.07, 1568, 0.14, 0.035); break;
        default: break;
      }
    } catch {}
  }
}
