// Meridian Courier: the game loop, the screens and the wiring. Title,
// play, pause, crash and complete; keyboard and mouse share one stick;
// ?shot=start|play|chase|end&seed=N stages one frozen, deterministic
// frame for the screenshots and never starts the loop or the audio.

import { attachInput, keyDown, newInput, readStick } from './input.js';
import { buildWorld } from './world.js';
import { autopilotInput, newPlane, resetPlane, stepPlane } from './physics.js';
import { createRenderer } from './render.js';
import { ensureAudio, newAudio, ringChime, setMuted, thud, updateAudio } from './audio.js';
import { stageShot } from './shots.js';

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');
const params = new URLSearchParams(window.location.search);
const seed = Number(params.get('seed') || 7) || 7;
const shot = params.get('shot');

const world = buildWorld(seed);
const plane = newPlane();
const input = newInput();
const audio = newAudio();
const renderer = createRenderer(canvas);

const game = {
  world,
  plane,
  screen: 'title', // title | play | pause | over | complete
  camera: 'chase', // chase | cockpit
  autopilot: false,
  muted: false,
  time: 0, // render clock, seconds (frozen in shot mode)
  best: 0,
  cam: null,
};

try {
  game.best = Number(window.localStorage.getItem('meridian-courier-best') || 0) || 0;
} catch {
  game.best = 0;
}

function resize() {
  const w = Math.min(window.innerWidth, 1920);
  const h = Math.min(window.innerHeight, 1080);
  canvas.width = w;
  canvas.height = h;
}
window.addEventListener('resize', resize);
resize();

function announce(text) {
  statusEl.textContent = text;
}

function startRun() {
  resetPlane(plane, world);
  game.screen = 'play';
  game.autopilot = false;
  game.time = 0;
  ensureAudio(audio);
  announce('Flying. Thread the glowing rings, then land on the strip.');
}

function endRun() {
  if (plane.score > game.best) {
    game.best = plane.score;
    try {
      window.localStorage.setItem('meridian-courier-best', String(game.best));
    } catch {
      // A private window is fine: the best score just does not persist.
    }
  }
}

const hooks = {
  onKey(key) {
    if (key === 'Enter') {
      if (game.screen === 'title' || game.screen === 'over' || game.screen === 'complete') startRun();
      return;
    }
    if (key === 'p' || key === 'P') {
      if (game.screen === 'play') game.screen = 'pause';
      else if (game.screen === 'pause') game.screen = 'play';
      return;
    }
    if (key === 'r' || key === 'R') {
      if (game.screen !== 'title') startRun();
      return;
    }
    if (key === 'c' || key === 'C') {
      game.camera = game.camera === 'chase' ? 'cockpit' : 'chase';
      return;
    }
    if (key === 'o' || key === 'O') {
      if (game.screen === 'play') game.autopilot = !game.autopilot;
      return;
    }
    if (key === 'm' || key === 'M') {
      game.muted = !game.muted;
      setMuted(audio, game.muted);
    }
  },
  onPointerDown() {
    ensureAudio(audio);
    if (game.screen === 'title' || game.screen === 'over' || game.screen === 'complete') startRun();
  },
};
attachInput(input, canvas, hooks);

let last = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game.screen === 'play') {
    game.time += dt;
    const stick = readStick(input);
    // Throttle is a held value: W/S nudge it, the autopilot sets it.
    if (stick.throttleDelta !== 0) {
      plane.throttle = Math.max(0, Math.min(1, plane.throttle + stick.throttleDelta * dt * 0.7));
    }
    const control = game.autopilot
      ? autopilotInput(plane, world)
      : { pitch: stick.pitch, roll: stick.roll, yaw: stick.yaw, throttle: plane.throttle };
    const event = stepPlane(plane, world, control, dt);
    if (event === 'ring') ringChime(audio);
    if (event === 'crash') {
      thud(audio, true);
      game.screen = 'over';
      endRun();
      announce('Crashed. Press R to fly again.');
    } else if (event === 'land') {
      thud(audio, false);
      game.screen = 'complete';
      endRun();
      announce(`Mail run complete. Score ${plane.score}.`);
    }
    updateAudio(audio, plane, true);
  } else if (game.screen === 'title') {
    // The title idles over the strip: slow drift, no rules running.
    game.time += dt * 0.25;
  }
  renderer.render(game);
  requestAnimationFrame(frame);
}

if (shot) {
  // Screenshot mode: stage one deterministic frame and stop. No loop, no
  // audio, no clock: the same seed always draws the same pixels.
  const staged = stageShot(shot, game);
  game.screen = staged.screen;
  game.time = game.time || 0;
  renderer.render(game);
} else {
  requestAnimationFrame(frame);
}
