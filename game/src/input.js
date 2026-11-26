// Input for Meridian Courier: keyboard and mouse, both steering the same
// stick. Arrow keys pitch and roll, A/D is the rudder, W/S is the throttle,
// C swaps chase and cockpit, A toggles the autopilot, M mutes, P pauses,
// R restarts, Enter starts. The mouse steers too: hold the pointer off
// centre and the plane banks toward it, so the game plays with one hand.

export function newInput() {
  return {
    keys: new Set(),
    mouseX: 0, // -1..1 across the canvas
    mouseY: 0, // -1..1 down the canvas
    mouseActive: false,
    mouseSeen: false,
  };
}

export function attachInput(input, canvas, hooks) {
  const down = (event) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) {
      event.preventDefault();
    }
    if (event.repeat) return;
    input.keys.add(event.key.length === 1 ? event.key.toLowerCase() : event.key);
    hooks.onKey(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  };
  const up = (event) => {
    input.keys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', () => input.keys.clear());

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    input.mouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    input.mouseY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    input.mouseActive = true;
    input.mouseSeen = true;
  });
  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    input.mouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    input.mouseY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    input.mouseActive = true;
    hooks.onPointerDown();
  });
  canvas.addEventListener('pointerleave', () => {
    input.mouseActive = false;
  });
}

export function keyDown(input, key) {
  return input.keys.has(key);
}

/**
 * Read the stick for this frame: keyboard wins while a key is held, the
 * mouse steers while it moves, and the two never fight — the last device
 * to move owns the stick until the other one moves again.
 */
export function readStick(input) {
  let pitch = 0;
  let roll = 0;
  let yaw = 0;
  let throttleDelta = 0;

  if (keyDown(input, 'ArrowUp')) pitch += 1;
  if (keyDown(input, 'ArrowDown')) pitch -= 1;
  if (keyDown(input, 'ArrowLeft')) roll -= 1;
  if (keyDown(input, 'ArrowRight')) roll += 1;
  if (keyDown(input, 'a')) yaw -= 1;
  if (keyDown(input, 'd')) yaw += 1;
  if (keyDown(input, 'w')) throttleDelta += 1;
  if (keyDown(input, 's')) throttleDelta -= 1;

  const keyboard = pitch !== 0 || roll !== 0;
  if (!keyboard && input.mouseActive && Math.hypot(input.mouseX, input.mouseY) > 0.06) {
    roll = input.mouseX;
    pitch = -input.mouseY;
  }
  return { pitch, roll, yaw, throttleDelta };
}
