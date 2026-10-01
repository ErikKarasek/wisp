// Tiny sounds made on the spot with Web Audio: a rising chime when something
// finishes, a low double note when it fails, a soft blip when it waits for you,
// and a squeak when you poke a character.

let ctx: AudioContext | null = null;

function tone(freq: number, start: number, length: number, type: OscillatorType = "sine", volume = 0.12) {
  ctx ??= new AudioContext();
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + length + 0.05);
}

export const sounds = {
  done() {
    tone(660, 0, 0.18);
    tone(880, 0.1, 0.25);
    tone(1320, 0.2, 0.35, "sine", 0.08);
  },
  bad() {
    tone(220, 0, 0.25, "triangle", 0.16);
    tone(165, 0.2, 0.4, "triangle", 0.16);
  },
  you() {
    tone(740, 0, 0.12, "sine", 0.1);
    tone(988, 0.12, 0.18, "sine", 0.08);
  },
  /** Two soft notes going up: the bot likes you. */
  love() {
    tone(784, 0, 0.16, "sine", 0.06);
    tone(1046, 0.12, 0.28, "sine", 0.05);
  },
  /** A short bright click. */
  wink() {
    tone(1318, 0, 0.07, "sine", 0.05);
    tone(1760, 0.05, 0.1, "sine", 0.04);
  },
  /** A slow slide down, like a yawn. */
  yawn() {
    ctx ??= new AudioContext();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(260, t + 0.7);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.05, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.85);
  },
  poke(pitch = 1) {
    ctx ??= new AudioContext();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(500 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(900 * pitch, t + 0.08);
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.16);
  },
};
