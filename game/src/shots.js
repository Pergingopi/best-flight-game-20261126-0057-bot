// The screenshot scenes behind ?shot=start|play|chase|end. Each one plays
// the real rules forward from a fresh world for a fixed number of steps,
// flown by the autopilot, so the frame is what a real game really looks
// like and the same seed always gives the same frame. The render is a
// single frozen frame: no wall clock, no audio, no randomness outside the
// seed.

import { autopilotInput, newPlane, resetPlane, stepPlane } from './physics.js';

const STEP = 1 / 30;

/** Fly `seconds` of autopilot, fixed steps, from the current state. */
function fly(plane, world, seconds) {
  for (let i = 0; i < Math.round(seconds / STEP); i += 1) {
    const event = stepPlane(plane, world, autopilotInput(plane, world), STEP);
    if (event === 'crash' || event === 'land') break;
  }
}

/**
 * Set the game to the named scene and return the screen to draw over it.
 * Any unknown name is the title scene.
 */
export function stageShot(name, game) {
  const { plane, world } = game;
  resetPlane(plane, world);
  game.camera = 'chase';
  game.autopilot = false;
  game.time = 0;

  if (name === 'play') {
    // Mid-run: climbing out of the valley, the next ring dead ahead over
    // the harbour, HUD lit, speed on.
    fly(plane, world, 14);
    game.time = 14;
    return { screen: 'play' };
  }
  if (name === 'chase') {
    // Low over the bay, mountains ahead, city off the wing.
    plane.x = 250;
    plane.z = 520;
    plane.y = 42;
    plane.heading = Math.PI * 0.72;
    plane.pitch = -0.02;
    plane.roll = -0.28;
    plane.speed = 62;
    plane.throttle = 0.7;
    plane.onGround = false;
    plane.score = 300;
    plane.time = 26;
    plane.ringsPassed = 2;
    world.rings[0].passed = true;
    world.rings[1].passed = true;
    game.time = 26;
    return { screen: 'play' };
  }
  if (name === 'end') {
    // The whole course flown, on short final: the strip fills the view,
    // gear down in spirit, mission about to complete.
    fly(plane, world, 400);
    if (!plane.landed && !plane.crashed) {
      // Autopilot finished the course but is still rolling out: hold the
      // frame on the runway with the complete banner up.
      plane.landed = true;
      plane.score += 500;
      plane.message = 'MAIL RUN COMPLETE  +500';
      plane.messageUntil = 9999;
    }
    game.time = plane.time;
    return { screen: 'complete' };
  }
  // start: parked at the threshold at dawn light, title over the strip.
  plane.throttle = 0.25;
  game.time = 0;
  return { screen: 'title' };
}

export { newPlane };
