// Procedural sound for Meridian Courier: no audio files, everything is
// synthesised with WebAudio — an engine drone that follows the throttle, wind
// that rises with speed, a chime when a ring is threaded and a thud for a
// crash. The context is created only after the player's first gesture, so
// a quiet page load stays quiet, and the screenshot scenes never make one.

export function newAudio() {
  return {
    ctx: null,
    master: null,
    engineOsc: null,
    engineGain: null,
    engineFilter: null,
    windGain: null,
    muted: false,
    ready: false,
  };
}

export function ensureAudio(audio) {
  if (audio.ready || audio.ctx) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const master = ctx.createGain();
    master.gain.value = audio.muted ? 0 : 0.5;
    master.connect(ctx.destination);

    // Engine: two detuned saws through a low-pass, pitch follows throttle.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 62;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = 93;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0.0;
    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(engineGain);
    engineGain.connect(master);
    osc.start();
    osc2.start();

    // Wind: looped noise through a band-pass, gain follows airspeed.
    const noiseLen = ctx.sampleRate * 2;
    const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i += 1) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 700;
    windFilter.Q.value = 0.6;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.0;
    noise.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(master);
    noise.start();

    audio.ctx = ctx;
    audio.master = master;
    audio.engineOsc = osc;
    audio.engineOsc2 = osc2;
    audio.engineGain = engineGain;
    audio.engineFilter = filter;
    audio.windGain = windGain;
    audio.ready = true;
  } catch {
    audio.ready = false;
  }
}

/** Call every frame while flying: drone and wind follow the plane. */
export function updateAudio(audio, plane, flying) {
  if (!audio.ready || !audio.ctx) return;
  const t = audio.ctx.currentTime;
  const throttle = plane.throttle;
  const speed = plane.speed;
  const engineLevel = flying && !plane.crashed ? 0.05 + throttle * 0.075 : 0.0;
  audio.engineGain.gain.setTargetAtTime(engineLevel, t, 0.1);
  audio.engineOsc.frequency.setTargetAtTime(52 + throttle * 68, t, 0.1);
  audio.engineOsc2.frequency.setTargetAtTime(78 + throttle * 102, t, 0.1);
  audio.engineFilter.frequency.setTargetAtTime(320 + throttle * 900, t, 0.1);
  const windLevel = flying && !plane.crashed ? Math.min(0.16, (speed / 92) * 0.16) : 0.0;
  audio.windGain.gain.setTargetAtTime(windLevel, t, 0.15);
}

/** A bright two-note chime for threading a ring. */
export function ringChime(audio) {
  if (!audio.ready || !audio.ctx) return;
  const ctx = audio.ctx;
  const t = ctx.currentTime;
  [880, 1318].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t + i * 0.09);
    gain.gain.exponentialRampToValueAtTime(0.22, t + i * 0.09 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.5);
    osc.connect(gain);
    gain.connect(audio.master);
    osc.start(t + i * 0.09);
    osc.stop(t + i * 0.09 + 0.55);
  });
}

/** A low thud for a crash, a soft bump for a touchdown. */
export function thud(audio, hard) {
  if (!audio.ready || !audio.ctx) return;
  const ctx = audio.ctx;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(hard ? 90 : 140, t);
  osc.frequency.exponentialRampToValueAtTime(38, t + (hard ? 0.4 : 0.18));
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(hard ? 0.5 : 0.2, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + (hard ? 0.5 : 0.25));
  osc.connect(gain);
  gain.connect(audio.master);
  osc.start(t);
  osc.stop(t + 0.55);
}

export function setMuted(audio, muted) {
  audio.muted = muted;
  if (audio.ready && audio.master) {
    audio.master.gain.setTargetAtTime(muted ? 0 : 0.5, audio.ctx.currentTime, 0.05);
  }
}
