// Flight model for Meridian Courier: an arcade model with just enough
// truth to feel like flying. Throttle sets a target speed, pitch trades
// speed for altitude, roll banks the turn, and below the stall speed the
// wing gives up and the nose drops. Rings are crossed by passing through
// their disc; a gentle touchdown on the strip is a landing, anything else
// on the ground is a crash. The autopilot is the same model driven by a
// simple controller, so the screenshot scenes fly the real rules.

import { clamp, wrapAngle } from './random.js';
import { RUNWAY, SEA_LEVEL, heightAt } from './world.js';

export const STALL_SPEED = 24; // m/s, below this the wing quits
export const MAX_SPEED = 92; // m/s at full throttle
export const RING_SCORE = 150;
export const LAND_BONUS = 500;

export function newPlane() {
  return {
    // Parked at the western threshold, lined up on the strip, nose east.
    x: RUNWAY.x - RUNWAY.length / 2 + 6,
    z: RUNWAY.z,
    y: 4.2,
    heading: Math.PI / 2,
    pitch: 0,
    roll: 0,
    speed: 0,
    throttle: 0,
    vy: 0,
    onGround: true,
    crashed: false,
    landed: false,
    ringsPassed: 0,
    score: 0,
    time: 0,
    message: '',
    messageUntil: 0,
  };
}

export function resetPlane(plane, world) {
  const fresh = newPlane();
  Object.assign(plane, fresh);
  for (const ring of world.rings) ring.passed = false;
}

/** Where the next ring is, or the strip when the course is done. */
export function nextTarget(plane, world) {
  for (const ring of world.rings) {
    if (!ring.passed) return { x: ring.x, y: ring.y, z: ring.z, ring };
  }
  return { x: RUNWAY.x + RUNWAY.length / 2 - 10, y: 5, z: RUNWAY.z, runway: true };
}

/**
 * One fixed step of the flight model. `input` is { pitch, roll, yaw,
 * throttle } with pitch/roll in [-1, 1] as stick deflection and throttle
 * in [0, 1] absolute. Returns an event string ('ring', 'crash', 'land')
 * or ''.
 */
export function stepPlane(plane, world, input, dt) {
  if (plane.crashed || plane.landed) return '';

  plane.time += dt;
  plane.throttle = clamp(input.throttle, 0, 1);

  // Roll follows the stick; the turn follows the bank.
  const targetRoll = clamp(input.roll, -1, 1) * 0.95;
  plane.roll += (targetRoll - plane.roll) * Math.min(1, dt * 3.2);
  const targetPitch = clamp(input.pitch, -1, 1) * 0.55;
  plane.pitch += (targetPitch - plane.pitch) * Math.min(1, dt * 2.6);

  // A banked turn: heading rate grows with bank and speed.
  plane.heading += (-Math.sin(plane.roll) * plane.speed * 0.0055
    + clamp(input.yaw, -1, 1) * 0.35 * dt);
  plane.heading = wrapAngle(plane.heading);

  // Speed chases the throttle's target; climbing bleeds it, diving feeds it.
  const targetSpeed = 14 + plane.throttle * (MAX_SPEED - 14);
  plane.speed += (targetSpeed - plane.speed) * Math.min(1, dt * 0.45);
  plane.speed -= Math.sin(plane.pitch) * 9 * dt;
  if (plane.onGround) plane.speed -= plane.speed * 0.12 * dt;
  plane.speed = clamp(plane.speed, 0, MAX_SPEED + 12);

  // Vertical speed: the wing lifts with pitch and speed, quits at stall.
  let vy = Math.sin(plane.pitch) * plane.speed;
  if (plane.speed < STALL_SPEED && !plane.onGround) {
    vy -= (STALL_SPEED - plane.speed) * 0.9;
  }
  plane.vy = vy;

  const fx = Math.sin(plane.heading);
  const fz = -Math.cos(plane.heading);
  plane.x += fx * plane.speed * dt;
  plane.z += fz * plane.speed * dt;
  plane.y += vy * dt;

  // Stay inside the island's airspace.
  plane.x = clamp(plane.x, 8, 1016);
  plane.z = clamp(plane.z, 8, 1016);
  if (plane.y > 220) {
    plane.y = 220;
    plane.pitch = Math.min(plane.pitch, 0);
  }

  // Rings: crossing the disc within its radius counts.
  for (const ring of world.rings) {
    if (ring.passed) continue;
    const dx = plane.x - ring.x;
    const dy = plane.y - ring.y;
    const dz = plane.z - ring.z;
    if (dx * dx + dy * dy + dz * dz < ring.r * ring.r) {
      ring.passed = true;
      plane.ringsPassed += 1;
      plane.score += RING_SCORE;
      plane.message = `RING ${plane.ringsPassed} / ${world.rings.length}  +${RING_SCORE}`;
      plane.messageUntil = plane.time + 2.2;
      return 'ring';
    }
  }

  // Ground contact. The surface is the terrain, or the sea itself where
  // the ground is under water: a plane ditches at sea level, not on the
  // sea bed.
  const ground = heightAt(world, plane.x, plane.z);
  const surface = Math.max(ground, SEA_LEVEL);
  const clearance = plane.y - surface;
  const wasAirborne = !plane.onGround;
  if (clearance <= 1.25) {
    if (wasAirborne && clearance <= 1.1) {
      // An airborne arrival: a gentle one is a touchdown, the rest is a crash.
      const onStrip = Math.abs(plane.x - RUNWAY.x) <= RUNWAY.length / 2 + 4
        && Math.abs(plane.z - RUNWAY.z) <= RUNWAY.width / 2 + 2;
      const gentle = Math.abs(vy) < 5.5 && Math.abs(plane.roll) < 0.35
        && plane.speed < 58 && plane.speed > 8;
      if (onStrip && gentle) {
        plane.y = surface + 1.1;
        plane.onGround = true;
        plane.pitch = 0;
        plane.roll *= 0.5;
        plane.speed = Math.max(0, plane.speed - 26 * dt);
        if (plane.ringsPassed >= world.rings.length && !plane.landed) {
          plane.landed = true;
          const timeBonus = Math.max(0, Math.round((300 - plane.time) * 2));
          plane.score += LAND_BONUS + timeBonus;
          plane.message = `MAIL RUN COMPLETE  +${LAND_BONUS}  time +${timeBonus}`;
          plane.messageUntil = plane.time + 6;
          return 'land';
        }
        plane.message = 'TOUCHDOWN — throttle up to go again';
        plane.messageUntil = plane.time + 2.5;
        return '';
      }
      plane.crashed = true;
      plane.message = ground < 0.4 ? 'DITCHED IN THE SEA' : 'CRASHED — press R to fly again';
      plane.messageUntil = plane.time + 6;
      return 'crash';
    }
    if (wasAirborne) {
      // Still flying, a hand's breadth above the surface: keep flying
      // until the arrival is decided at 1.1 m, never snap to the ground.
      plane.onGround = false;
      return '';
    }
    // Rolling on the ground: stay glued unless rotating for take-off.
    const rotating = plane.speed > 36 && plane.pitch > 0.2;
    if (!rotating) {
      plane.y = surface + 1.1;
      plane.onGround = true;
      plane.vy = 0;
    } else {
      plane.onGround = false;
    }
    return '';
  }
  plane.onGround = false;
  if (plane.y < ground + 9 && plane.speed > 30) {
    plane.message = 'PULL UP';
    plane.messageUntil = plane.time + 0.5;
  }
  return '';
}

/**
 * The autopilot: a plain controller on the same model. It steers for the
 * next ring (or the strip, on final), holds its altitude, and flares for
 * the landing. The screenshot scenes and the in-game A key both use it.
 */
export function autopilotInput(plane, world) {
  const target = nextTarget(plane, world);
  const dx = target.x - plane.x;
  const dz = target.z - plane.z;
  const dist = Math.hypot(dx, dz);
  const wantHeading = Math.atan2(dx, -dz);
  const headingErr = wrapAngle(wantHeading - plane.heading);

  let roll = clamp(-headingErr * 1.6, -1, 1);
  let pitch = 0;
  let throttle = 0.72;

  if (target.runway) {
    // Land eastbound on the strip. A final is a line, not a point: hold
    // the extended centreline and ride the glide path down, flaring over
    // the numbers. Anything not lined up rejoins the pattern at the
    // approach fix, 170 m west of the threshold at 16 m — a go-around,
    // never an orbit around a point a few metres away.
    const threshX = RUNWAY.x - RUNWAY.length / 2;
    const latErr = plane.z - RUNWAY.z;
    const distThresh = Math.hypot(threshX - plane.x, latErr);
    const linedUp = Math.abs(latErr) < 45 && plane.x < threshX + 130
      && Math.abs(wrapAngle(Math.PI / 2 - plane.heading)) < 1.1;
    if (linedUp && distThresh < 260) {
      const wantHeading = Math.PI / 2 - clamp(latErr * 0.02, -0.45, 0.45);
      const herr = wrapAngle(wantHeading - plane.heading);
      roll = clamp(-herr * 1.8, -1, 1);
      // Glide path ends just below the touchdown height, so the controller
      // keeps descending into contact instead of floating above the strip.
      const desY = 3.9 + Math.max(0, threshX - plane.x) * 0.09;
      const altErr = desY - plane.y;
      pitch = clamp(altErr * 0.09, -0.3, 0.3);
      throttle = plane.x > threshX - 20 ? 0.14 : 0.25;
      if (plane.x > threshX - 10) {
        // Flare: ease the descent, but never lift — the wheels must
        // still find the strip.
        pitch = clamp(altErr * 0.1 + 0.03, -0.12, 0.3);
        roll = clamp(-herr * 2.4, -0.4, 0.4);
      }
    } else {
      const aimX = threshX - 170;
      const aimY = 16;
      const aimZ = RUNWAY.z;
      throttle = 0.55;
      const aimDx = aimX - plane.x;
      const aimDz = aimZ - plane.z;
      const aimHeading = Math.atan2(aimDx, -aimDz);
      const aimErr = wrapAngle(aimHeading - plane.heading);
      roll = clamp(-aimErr * 1.8, -1, 1);
      const altErr = aimY - plane.y;
      pitch = clamp(altErr * 0.09, -0.3, 0.3);
    }
  } else {
    const altErr = target.y - plane.y;
    pitch = clamp(altErr * 0.045, -0.55, 0.55);
    if (plane.speed < STALL_SPEED + 6) throttle = 0.9;
  }
  if (plane.onGround) {
    // Take-off roll: wings level, throttle up, rotate at speed.
    roll = 0;
    throttle = 1;
    pitch = plane.speed > 34 ? 0.5 : 0;
  }
  return { pitch, roll, yaw: 0, throttle };
}
