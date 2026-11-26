// Renderer for Meridian Courier: a voxel-space terrain view — sky, sun and
// clouds, a procedural island marched column by column into a half-size
// buffer and upscaled, then the harbour buildings, the glowing rings and
// the little courier plane drawn on top at full resolution, and a lit HUD.
// Everything is drawn from the world data; there are no image assets.

import { clamp, lerp, valueNoise, wrapAngle } from './random.js';
import { CITY, PALETTE, RUNWAY, SEA_LEVEL, groundPalette, heightAt } from './world.js';
import { STALL_SPEED } from './physics.js';

const FOV_V = (62 * Math.PI) / 180;
const TW = 640; // terrain buffer width
const TH = 360; // terrain buffer height
const FAR = 470;
const HAZE = [208, 226, 240];

// Fog table: palette id x distance bucket -> packed ABGR pixel.
const FOG_BUCKETS = 48;
const fogTable = [];
for (let i = 0; i < PALETTE.length; i += 1) {
  const row = new Uint32Array(FOG_BUCKETS);
  for (let b = 0; b < FOG_BUCKETS; b += 1) {
    const f = Math.pow(b / (FOG_BUCKETS - 1), 1.15) * 0.88;
    const r = Math.round(lerp(PALETTE[i][0], HAZE[0], f));
    const g = Math.round(lerp(PALETTE[i][1], HAZE[1], f));
    const bl = Math.round(lerp(PALETTE[i][2], HAZE[2], f));
    row[b] = (255 << 24) | (bl << 16) | (g << 8) | r;
  }
  fogTable.push(row);
}

function fogColor(id, dist) {
  const b = Math.min(FOG_BUCKETS - 1, Math.floor((dist / FAR) * FOG_BUCKETS));
  return fogTable[id][b];
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const terrainCanvas = document.createElement('canvas');
  terrainCanvas.width = TW;
  terrainCanvas.height = TH;
  const terrainCtx = terrainCanvas.getContext('2d');
  const image = terrainCtx.createImageData(TW, TH);
  const pixels = new Uint32Array(image.data.buffer);
  const ybuf = new Float32Array(TW);

  // ---- camera ----------------------------------------------------------
  function computeCamera(plane, mode, W, H) {
    const focal = H / 2 / Math.tan(FOV_V / 2);
    let cx;
    let cy;
    let cz;
    let heading = plane.heading;
    let pitch;
    let roll;
    if (mode === 'cockpit') {
      pitch = plane.pitch;
      roll = plane.roll;
      const fx = Math.sin(heading);
      const fz = -Math.cos(heading);
      cx = plane.x + fx * 1.2;
      cy = plane.y + 0.3;
      cz = plane.z + fz * 1.2;
    } else {
      pitch = plane.pitch * 0.45 - 0.045;
      roll = plane.roll * 0.55;
      const fx = Math.sin(plane.heading);
      const fz = -Math.cos(plane.heading);
      cx = plane.x - fx * 13;
      cy = plane.y + 3.6 - Math.sin(plane.pitch) * 2;
      cz = plane.z - fz * 13;
    }
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const fwd = [Math.sin(heading) * cp, sp, -Math.cos(heading) * cp];
    // right0 = cross(fwd, world up), normalised.
    let right0 = [-fwd[2], 0, fwd[0]];
    const rl = Math.hypot(right0[0], right0[2]) || 1;
    right0 = [right0[0] / rl, 0, right0[2] / rl];
    const up0 = [
      right0[1] * fwd[2] - right0[2] * fwd[1],
      right0[2] * fwd[0] - right0[0] * fwd[2],
      right0[0] * fwd[1] - right0[1] * fwd[0],
    ];
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const right = [
      right0[0] * cr + up0[0] * sr,
      right0[1] * cr + up0[1] * sr,
      right0[2] * cr + up0[2] * sr,
    ];
    const up = [
      up0[0] * cr - right0[0] * sr,
      up0[1] * cr - right0[1] * sr,
      up0[2] * cr - right0[2] * sr,
    ];
    return {
      x: cx, y: cy, z: cz, heading, pitch, roll, focal,
      horizonY: H / 2 + Math.tan(pitch) * focal,
      fwd, right, up, W, H,
    };
  }

  function project(cam, x, y, z) {
    const vx = x - cam.x;
    const vy = y - cam.y;
    const vz = z - cam.z;
    const zc = vx * cam.fwd[0] + vy * cam.fwd[1] + vz * cam.fwd[2];
    if (zc < 1.5) return null;
    const xc = vx * cam.right[0] + vy * cam.right[1] + vz * cam.right[2];
    const yc = vx * cam.up[0] + vy * cam.up[1] + vz * cam.up[2];
    return {
      sx: cam.W / 2 + (xc * cam.focal) / zc,
      sy: cam.horizonY - (yc * cam.focal) / zc,
      zc,
      scale: cam.focal / zc,
    };
  }

  // ---- sky ---------------------------------------------------------------
  function drawSky(cam) {
    const { W, H } = cam;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2b6cc4');
    g.addColorStop(0.45, '#6fa8de');
    g.addColorStop(0.62, '#bcd9ef');
    g.addColorStop(0.75, '#e8f1f8');
    g.addColorStop(1, '#dfe9ef');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Sun: fixed in the sky to the south-east, high and warm.
    const az = Math.PI * 0.78;
    const el = 0.62;
    const dir = [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
    const zc = dir[0] * cam.fwd[0] + dir[1] * cam.fwd[1] + dir[2] * cam.fwd[2];
    if (zc > 0.05) {
      const xc = dir[0] * cam.right[0] + dir[1] * cam.right[1] + dir[2] * cam.right[2];
      const yc = dir[0] * cam.up[0] + dir[1] * cam.up[1] + dir[2] * cam.up[2];
      const sx = W / 2 + (xc * cam.focal) / zc;
      const sy = cam.horizonY - (yc * cam.focal) / zc;
      const glow = ctx.createRadialGradient(sx, sy, 4, sx, sy, 150);
      glow.addColorStop(0, 'rgba(255, 246, 214, 0.95)');
      glow.addColorStop(0.25, 'rgba(255, 238, 180, 0.45)');
      glow.addColorStop(1, 'rgba(255, 238, 180, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(sx - 160, sy - 160, 320, 320);
      ctx.fillStyle = '#fff8dc';
      ctx.beginPath();
      ctx.arc(sx, sy, 17, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- terrain -------------------------------------------------------------
  function drawTerrain(world, cam, time) {
    const focalT = TH / 2 / Math.tan(FOV_V / 2);
    const fovH = 2 * Math.atan(Math.tan(FOV_V / 2) * (TW / TH));
    const horizonT = TH / 2 + Math.tan(cam.pitch) * focalT;
    const rollSlope = Math.tan(cam.roll);
    pixels.fill(0);
    for (let i = 0; i < TW; i += 1) ybuf[i] = TH;
    for (let i = 0; i < TW; i += 1) {
      const alpha = (i / TW - 0.5) * fovH;
      const rayH = cam.heading + alpha;
      const sinH = Math.sin(rayH);
      const cosH = -Math.cos(rayH);
      const cosA = Math.cos(alpha);
      const horizonCol = horizonT + (i - TW / 2) * rollSlope;
      let d = 5;
      let top = TH;
      while (d < FAR) {
        const px = cam.x + sinH * d;
        const pz = cam.z + cosH * d;
        let h = heightAt(world, px, pz);
        let id;
        if (h < SEA_LEVEL) {
          h = SEA_LEVEL;
          const wave = valueNoise(px * 0.08 + time * 0.35, pz * 0.08, world.seed + 21);
          id = wave < 0.45 ? 0 : 1;
        } else {
          id = groundPalette(world, px, pz, h);
        }
        const depth = d * cosA;
        const sy = horizonCol - ((h - cam.y) * focalT) / depth;
        if (sy < top) {
          const color = fogColor(id, depth);
          const y0 = Math.max(0, Math.floor(sy));
          const y1 = Math.min(TH, Math.ceil(top));
          for (let y = y0; y < y1; y += 1) pixels[y * TW + i] = color;
          top = sy;
        }
        if (top <= 0) break;
        d += 1 + d * 0.035;
      }
    }
    terrainCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(terrainCanvas, 0, 0, cam.W, cam.H);
  }

  // ---- clouds ---------------------------------------------------------------
  function drawClouds(world, cam, time) {
    ctx.save();
    for (const c of world.clouds) {
      const driftedX = ((c.x + c.drift * time) % 1024 + 1024) % 1024;
      const p = project(cam, driftedX, c.y, c.z);
      if (!p || p.zc > 700) continue;
      const rx = c.rx * p.scale;
      const ry = c.ry * p.scale;
      if (rx < 2 || p.sx < -rx * 2 || p.sx > cam.W + rx * 2 || p.sy < -ry * 2 || p.sy > cam.H + ry * 2) continue;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
      for (const [ox, oy, s] of [[-0.55, 0.1, 0.62], [0, -0.12, 0.85], [0.55, 0.12, 0.6], [0.15, 0.18, 0.7]]) {
        ctx.beginPath();
        ctx.ellipse(p.sx + ox * rx, p.sy + oy * ry, rx * s, ry * s, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---- buildings -------------------------------------------------------------
  function drawBuildings(world, cam) {
    const list = [];
    for (const b of world.buildings) {
      const dx = b.x - cam.x;
      const dz = b.z - cam.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 300) continue;
      list.push({ b, dist });
    }
    list.sort((a, b) => b.dist - a.dist);
    for (const { b } of list) {
      const hw = b.w / 2;
      const hd = b.d / 2;
      const base = heightAt(world, b.x, b.z);
      const top = base + b.h;
      // A skirt sunk 4 m into the ground, so a building never floats
      // above the terrain its base sits on.
      const skirt = base - 4;
      const c = [
        project(cam, b.x - hw, skirt, b.z - hd),
        project(cam, b.x + hw, skirt, b.z - hd),
        project(cam, b.x + hw, skirt, b.z + hd),
        project(cam, b.x - hw, skirt, b.z + hd),
        project(cam, b.x - hw, top, b.z - hd),
        project(cam, b.x + hw, top, b.z - hd),
        project(cam, b.x + hw, top, b.z + hd),
        project(cam, b.x - hw, top, b.z + hd),
      ];
      if (c.some((p) => p === null)) continue;
      // A contact shadow on the ground under the building, so it reads
      // as standing on the terrain even through the haze.
      const bc = project(cam, b.x, base, b.z);
      if (bc) {
        const sr = Math.max(3, (b.w / 2) * bc.scale * 0.9);
        ctx.fillStyle = 'rgba(10, 20, 30, 0.28)';
        ctx.beginPath();
        ctx.ellipse(bc.sx, bc.sy, sr, sr * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      const roof = PALETTE[b.shade];
      const sideA = roof.map((v) => Math.round(v * 0.85));
      const sideB = roof.map((v) => Math.round(v * 0.65));
      const poly = (pts, fill) => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.moveTo(pts[0].sx, pts[0].sy);
        for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].sx, pts[i].sy);
        ctx.closePath();
        ctx.fill();
      };
      // South + east faces, then the roof, so nearer faces win visually.
      poly([c[2], c[3], c[7], c[6]], `rgb(${sideB[0]},${sideB[1]},${sideB[2]})`);
      poly([c[1], c[2], c[6], c[5]], `rgb(${sideA[0]},${sideA[1]},${sideA[2]})`);
      poly([c[4], c[5], c[6], c[7]], `rgb(${roof[0]},${roof[1]},${roof[2]})`);
      if (b.tower) {
        ctx.fillStyle = '#ff5a4e';
        ctx.beginPath();
        ctx.arc(c[6].sx, c[6].sy, clamp(2.5 * c[6].scale, 2, 6), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---- rings ------------------------------------------------------------------
  function drawRings(world, cam, plane) {
    const target = world.rings.find((r) => !r.passed) ?? null;
    for (const ring of world.rings) {
      if (ring.passed) continue;
      const p = project(cam, ring.x, ring.y, ring.z);
      if (!p) continue;
      const isNext = ring === target;
      const rx = ring.r * p.scale;
      const ry = ring.r * p.scale * 0.92;
      if (rx < 1.5) continue;
      ctx.save();
      ctx.lineWidth = isNext ? 5 : 3;
      ctx.strokeStyle = isNext ? '#ffb63d' : '#7df9ff';
      ctx.shadowColor = isNext ? '#ff9d00' : '#37c8e8';
      ctx.shadowBlur = isNext ? 22 : 12;
      ctx.beginPath();
      ctx.ellipse(p.sx, p.sy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.ellipse(p.sx, p.sy, rx * 0.82, ry * 0.82, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      if (isNext && p.sx > 60 && p.sx < cam.W - 60 && p.sy > 40 && p.sy < cam.H - 40) {
        const dist = Math.hypot(plane.x - ring.x, plane.y - ring.y, plane.z - ring.z);
        const label = `RING ${ring.index + 1} · ${Math.round(dist)} m`;
        ctx.font = '700 15px ui-monospace, Menlo, Consolas, monospace';
        ctx.textAlign = 'center';
        const lw = ctx.measureText(label).width + 20;
        ctx.fillStyle = 'rgba(6, 20, 34, 0.65)';
        ctx.beginPath();
        ctx.roundRect(p.sx - lw / 2, p.sy - ry - 30, lw, 24, 6);
        ctx.fill();
        ctx.fillStyle = '#fff3d0';
        ctx.fillText(label, p.sx, p.sy - ry - 12);
      }
    }
    // Off-screen pointer to the next ring: it sits on the edge the pilot
    // must turn toward — left when the ring is left of the nose, right
    // when it is right — high when the ring is above, low when below.
    if (target) {
      const p = project(cam, target.x, target.y, target.z);
      if (p === null || p.sx < 30 || p.sx > cam.W - 30 || p.sy < 30 || p.sy > cam.H - 30) {
        const dx = target.x - cam.x;
        const dz = target.z - cam.z;
        const err = wrapAngle(Math.atan2(dx, -dz) - cam.heading);
        const mx = err >= 0 ? cam.W - 46 : 46;
        const my = target.y > cam.y ? cam.H * 0.35 : cam.H * 0.55;
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(err >= 0 ? 0 : Math.PI);
        ctx.fillStyle = '#ffb63d';
        ctx.beginPath();
        ctx.moveTo(12, 0);
        ctx.lineTo(-8, -9);
        ctx.lineTo(-8, 9);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // ---- the plane ----------------------------------------------------------------
  function drawPlane(cam, plane, time, lowered) {
    if (cam.mode === 'cockpit') return;
    const W = cam.W;
    const H = cam.H;
    const cx = W / 2;
    // On the title screen the plane sits low over the strip, clear of the
    // text; in flight it rides at the centre of the view.
    const cy = lowered ? H * 0.80 : H * 0.60;
    const s = Math.min(W, H) / 720 * (lowered ? 0.85 : 1);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-plane.roll * 0.85);
    ctx.scale(s, s);
    // Propeller disc, spinning: faint, so it reads as motion, not a fin.
    const spin = (time * 40) % (Math.PI * 2);
    ctx.save();
    ctx.translate(0, -2);
    ctx.rotate(spin * 0.2);
    ctx.fillStyle = 'rgba(30, 40, 52, 0.20)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 5, 32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Tail.
    ctx.fillStyle = '#e8590c';
    ctx.beginPath();
    ctx.moveTo(-14, -28);
    ctx.lineTo(-44, -52);
    ctx.lineTo(-50, -42);
    ctx.lineTo(-20, -20);
    ctx.closePath();
    ctx.fill();
    // Wings, swept back.
    ctx.fillStyle = '#f2f5f7';
    ctx.beginPath();
    ctx.moveTo(-14, -18);
    ctx.lineTo(-118, 6);
    ctx.lineTo(-112, 20);
    ctx.lineTo(-10, 2);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(14, -18);
    ctx.lineTo(118, 6);
    ctx.lineTo(112, 20);
    ctx.lineTo(10, 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#e8590c';
    ctx.fillRect(-118, 8, 24, 5);
    ctx.fillRect(94, 8, 24, 5);
    // Fuselage.
    const body = ctx.createLinearGradient(0, -26, 0, 14);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.55, '#dce8f2');
    body.addColorStop(1, '#9fb4c6');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(0, -72);
    ctx.quadraticCurveTo(16, -58, 15, -30);
    ctx.quadraticCurveTo(14, 2, 8, 10);
    ctx.quadraticCurveTo(0, 14, -8, 10);
    ctx.quadraticCurveTo(-14, 2, -15, -30);
    ctx.quadraticCurveTo(-16, -58, 0, -72);
    ctx.closePath();
    ctx.fill();
    // Livery stripe.
    ctx.fillStyle = '#0e7490';
    ctx.beginPath();
    ctx.moveTo(-14, -34);
    ctx.quadraticCurveTo(0, -28, 14, -34);
    ctx.lineTo(13, -24);
    ctx.quadraticCurveTo(0, -18, -13, -24);
    ctx.closePath();
    ctx.fill();
    // Cockpit windows, lit.
    ctx.fillStyle = '#bfe9ff';
    ctx.beginPath();
    ctx.moveTo(-9, -62);
    ctx.quadraticCurveTo(0, -68, 9, -62);
    ctx.lineTo(7, -48);
    ctx.quadraticCurveTo(0, -52, -7, -48);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#0e7490';
    ctx.font = '700 11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('M-01', 0, -6);
    // Spinner.
    ctx.fillStyle = '#e8590c';
    ctx.beginPath();
    ctx.arc(0, -2, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---- cockpit -------------------------------------------------------------------
  function drawCockpit(cam, plane) {
    const { W, H } = cam;
    const panelH = H * 0.30;
    const top = H - panelH;
    // Windshield frame.
    ctx.fillStyle = '#101c28';
    ctx.fillRect(0, 0, 10, H);
    ctx.fillRect(W - 10, 0, 10, H);
    ctx.fillRect(0, 0, W, 8);
    ctx.save();
    ctx.translate(W / 2, 0);
    ctx.rotate(0.06);
    ctx.fillRect(-5, 0, 10, top * 0.72);
    ctx.restore();
    ctx.save();
    ctx.translate(W / 2, 0);
    ctx.rotate(-0.06);
    ctx.fillRect(-5, 0, 10, top * 0.72);
    ctx.restore();
    // Dashboard.
    const g = ctx.createLinearGradient(0, top, 0, H);
    g.addColorStop(0, '#1b2c3c');
    g.addColorStop(1, '#0a141e');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, H);
    ctx.lineTo(0, top + 26);
    ctx.quadraticCurveTo(W / 2, top - 14, W, top + 26);
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
    const cx = W / 2;
    const cy = top + panelH * 0.52;
    const r = Math.min(panelH * 0.42, 74);
    // Artificial horizon, lit.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-plane.roll);
    ctx.translate(0, plane.pitch * r * 1.6);
    ctx.fillStyle = '#3f8fd2';
    ctx.fillRect(-r * 2, -r * 2, r * 4, r * 2);
    ctx.fillStyle = '#7a5a34';
    ctx.fillRect(-r * 2, 0, r * 4, r * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-r * 2, -1.5, r * 4, 3);
    ctx.restore();
    ctx.strokeStyle = '#cfe6ff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffc46b';
    ctx.beginPath();
    ctx.moveTo(cx - 16, cy);
    ctx.lineTo(cx + 16, cy);
    ctx.lineTo(cx, cy + 7);
    ctx.closePath();
    ctx.fill();
    // Round gauges: airspeed left, altitude right, throttle far right.
    const gauge = (gx, label, value, unit) => {
      ctx.fillStyle = '#0d1b28';
      ctx.beginPath();
      ctx.arc(gx, cy, r * 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#5f7d99';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#9fe8ff';
      ctx.font = '700 20px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(value), gx, cy - 2);
      ctx.fillStyle = '#8fb0c7';
      ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(label, gx, cy + 16);
      ctx.fillText(unit, gx, cy + 30);
    };
    gauge(cx - r * 2.1, 'AIRSPEED', Math.round(plane.speed * 1.94), 'KT');
    gauge(cx + r * 2.1, 'ALTITUDE', Math.round(plane.y * 3.28), 'FT');
    // Throttle lever.
    const tx = W - 70;
    ctx.fillStyle = '#0d1b28';
    ctx.fillRect(tx - 14, top + 18, 28, panelH - 36);
    ctx.strokeStyle = '#5f7d99';
    ctx.strokeRect(tx - 14, top + 18, 28, panelH - 36);
    const leverY = top + 18 + (panelH - 36) * (1 - plane.throttle);
    ctx.fillStyle = '#ffc46b';
    ctx.fillRect(tx - 20, leverY - 5, 40, 10);
    ctx.fillStyle = '#8fb0c7';
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('THR', tx, top + panelH - 8);
    // Warning lights.
    if (plane.speed < 28 && !plane.onGround) {
      ctx.fillStyle = '#ff3b30';
      ctx.beginPath();
      ctx.arc(70, top + 34, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd7d4';
      ctx.font = '700 12px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('STALL', 86, top + 38);
    }
  }

  // ---- HUD ------------------------------------------------------------------------
  function panel(x, y, w, h) {
    ctx.fillStyle = 'rgba(6, 20, 34, 0.55)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(159, 232, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawHUD(game) {
    const { plane, world, screen } = game;
    const { W, H } = game.cam;
    const knots = Math.round(plane.speed * 1.94);
    const feet = Math.round(plane.y * 3.28);
    const headingDeg = Math.round(((plane.heading * 180) / Math.PI + 360) % 360);
    const minutes = Math.floor(plane.time / 60);
    const seconds = Math.floor(plane.time % 60).toString().padStart(2, '0');

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Top-left: score, rings, time.
    panel(14, 14, 218, 64);
    ctx.fillStyle = '#9fe8ff';
    ctx.font = '700 20px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(`SCORE ${plane.score}`, 26, 40);
    ctx.fillStyle = '#e8f4ff';
    ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(`RINGS ${plane.ringsPassed}/${world.rings.length}   TIME ${minutes}:${seconds}`, 26, 62);

    // Top-right: next objective.
    const target = world.rings.find((r) => !r.passed);
    const objective = target
      ? `NEXT · RING ${target.index + 1} — ${Math.round(Math.hypot(plane.x - target.x, plane.y - target.y, plane.z - target.z))} m`
      : plane.landed ? 'MAIL RUN COMPLETE' : 'ALL RINGS DONE — LAND ON THE STRIP';
    ctx.font = '700 14px ui-monospace, Menlo, Consolas, monospace';
    const ow = ctx.measureText(objective).width + 28;
    panel(W - 14 - ow, 14, ow, 34);
    ctx.fillStyle = target ? '#ffc46b' : '#7dffa8';
    ctx.fillText(objective, W - 14 - ow + 14, 37);

    // Left: airspeed tape + throttle.
    panel(14, H / 2 - 86, 64, 172);
    ctx.fillStyle = '#8fb0c7';
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('KT', 46, H / 2 - 66);
    ctx.fillStyle = '#9fe8ff';
    ctx.font = '700 22px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(String(knots), 46, H / 2 - 38);
    ctx.fillStyle = '#22394e';
    ctx.fillRect(26, H / 2 - 24, 40, 66);
    ctx.fillStyle = '#ffb63d';
    ctx.fillRect(26, H / 2 - 24 + 66 * (1 - plane.throttle), 40, 66 * plane.throttle);
    ctx.fillStyle = '#8fb0c7';
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText('THR', 46, H / 2 + 58);

    // Right: altitude tape + vertical speed.
    panel(W - 102, H / 2 - 86, 88, 172);
    ctx.fillStyle = '#8fb0c7';
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('FT', W - 58, H / 2 - 66);
    ctx.fillStyle = '#9fe8ff';
    ctx.font = '700 22px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(String(feet), W - 58, H / 2 - 38);
    const vs = Math.round(plane.vy * 196.85);
    ctx.fillStyle = vs >= 0 ? '#7dffa8' : '#ff9d5c';
    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(`${vs >= 0 ? '+' : ''}${vs} fpm`, W - 58, H / 2 - 14);
    const agl = Math.max(0, Math.round((plane.y - heightAt(world, plane.x, plane.z)) * 3.28));
    ctx.fillStyle = '#8fb0c7';
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText(`AGL ${agl}`, W - 58, H / 2 + 58);

    // Bottom: compass tape.
    const tapeW = Math.min(560, W * 0.5);
    const tapeX = (W - tapeW) / 2;
    const tapeY = H - 44;
    panel(tapeX, tapeY, tapeW, 32);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(tapeX, tapeY, tapeW, 32, 8);
    ctx.clip();
    ctx.fillStyle = '#e8f4ff';
    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    const pxPerDeg = tapeW / 120;
    for (let d = -60; d <= 60; d += 5) {
      const deg = Math.round(((headingDeg + d) % 360 + 360) % 360);
      const x = tapeX + tapeW / 2 + d * pxPerDeg;
      const cardinal = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[deg];
      if (cardinal) {
        ctx.fillStyle = '#ffc46b';
        ctx.font = '700 14px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillText(cardinal, x, tapeY + 21);
        ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
      } else if (deg % 30 === 0) {
        ctx.fillStyle = '#e8f4ff';
        ctx.fillText(String(deg).padStart(3, '0'), x, tapeY + 21);
      } else {
        ctx.fillStyle = '#5f7d99';
        ctx.fillRect(x, tapeY + 8, 1, 8);
      }
    }
    ctx.restore();
    ctx.fillStyle = '#ffc46b';
    ctx.beginPath();
    ctx.moveTo(W / 2 - 7, tapeY - 2);
    ctx.lineTo(W / 2 + 7, tapeY - 2);
    ctx.lineTo(W / 2, tapeY + 7);
    ctx.closePath();
    ctx.fill();
    // Current heading as a chip above the tape, clear of the canvas edge.
    const hdgLabel = `HDG ${String(headingDeg).padStart(3, '0')}°`;
    ctx.font = '700 13px ui-monospace, Menlo, Consolas, monospace';
    const hw = ctx.measureText(hdgLabel).width + 18;
    ctx.fillStyle = 'rgba(6, 20, 34, 0.55)';
    ctx.beginPath();
    ctx.roundRect(W / 2 - hw / 2, tapeY - 30, hw, 22, 6);
    ctx.fill();
    ctx.fillStyle = '#9fe8ff';
    ctx.textAlign = 'center';
    ctx.fillText(hdgLabel, W / 2, tapeY - 14);

    // Centre: flight-path crosshair + horizon bar.
    if (game.cam.mode !== 'cockpit' && screen === 'play') {
      const cx = W / 2;
      const cy = H * 0.42;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-plane.roll * 0.55);
      ctx.strokeStyle = 'rgba(232, 244, 255, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-46, plane.pitch * 120);
      ctx.lineTo(46, plane.pitch * 120);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(255, 198, 107, 0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.moveTo(cx - 18, cy);
      ctx.lineTo(cx - 10, cy);
      ctx.moveTo(cx + 10, cy);
      ctx.lineTo(cx + 18, cy);
      ctx.moveTo(cx, cy - 18);
      ctx.lineTo(cx, cy - 10);
      ctx.stroke();
    }

    // Stall + autopilot flags.
    if (plane.speed < STALL_SPEED + 4 && !plane.onGround && screen === 'play') {
      ctx.fillStyle = '#ff3b30';
      ctx.font = '700 26px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('STALL', W / 2, 108);
    }
    if (game.autopilot) {
      ctx.fillStyle = '#ffc46b';
      ctx.font = '700 13px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.fillText('AUTOPILOT', W - 16, 66);
    }
    if (game.muted) {
      ctx.fillStyle = '#8fb0c7';
      ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.fillText('MUTED', W - 16, 86);
    }

    // Transient centre message.
    if (plane.message && plane.time < plane.messageUntil) {
      ctx.fillStyle = '#fff3d0';
      ctx.font = '700 24px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 8;
      ctx.fillText(plane.message, W / 2, 148);
      ctx.shadowBlur = 0;
    }
  }

  // ---- screens ---------------------------------------------------------------
  function drawTitle(game) {
    const { W, H } = game.cam;
    ctx.fillStyle = 'rgba(4, 16, 28, 0.30)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 64px ui-monospace, Menlo, Consolas, monospace';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 16;
    ctx.fillText('MERIDIAN COURIER', W / 2, H * 0.30);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffd9a0';
    ctx.font = '20px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText('Fly the island mail run — eight rings, one strip, no second chances', W / 2, H * 0.30 + 38);
    ctx.fillStyle = '#e8f4ff';
    ctx.font = '15px ui-monospace, Menlo, Consolas, monospace';
    const lines = [
      '↑ ↓ pitch      ← → roll      A / D rudder      W / S throttle',
      'Mouse steers too — hold the pointer off centre to bank',
      'C cockpit view      O autopilot      M mute      P pause      R restart',
      'Thread every glowing ring, then put her down gently on the strip.',
    ];
    lines.forEach((line, i) => ctx.fillText(line, W / 2, H * 0.52 + i * 26));
    ctx.fillStyle = '#7dffa8';
    ctx.font = '700 22px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText('CLICK OR PRESS ENTER TO FLY', W / 2, H * 0.52 + 4 * 26 + 26);
    if (game.best > 0) {
      ctx.fillStyle = '#9fe8ff';
      ctx.font = '15px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(`BEST SCORE ${game.best}`, W / 2, H * 0.52 + 4 * 26 + 56);
    }
  }

  function drawOverlay(game, title, lines) {
    const { W, H } = game.cam;
    ctx.fillStyle = 'rgba(4, 16, 28, 0.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 52px ui-monospace, Menlo, Consolas, monospace';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 14;
    ctx.fillText(title, W / 2, H * 0.42);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#e8f4ff';
    ctx.font = '17px ui-monospace, Menlo, Consolas, monospace';
    lines.forEach((line, i) => ctx.fillText(line, W / 2, H * 0.42 + 40 + i * 28));
  }

  // ---- the frame -----------------------------------------------------------
  function render(game) {
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    const cam = computeCamera(game.plane, game.camera, canvasW, canvasH);
    cam.mode = game.camera;
    game.cam = cam;
    ctx.clearRect(0, 0, canvasW, canvasH);
    drawSky(cam);
    drawTerrain(game.world, cam, game.time);
    drawClouds(game.world, cam, game.time);
    drawBuildings(game.world, cam);
    drawRings(game.world, cam, game.plane);
    if (game.camera === 'cockpit') {
      drawCockpit(cam, game.plane);
    } else {
      drawPlane(cam, game.plane, game.time, game.screen === 'title');
    }
    if (game.screen === 'title') {
      drawTitle(game);
    } else {
      drawHUD(game);
      if (game.screen === 'pause') {
        drawOverlay(game, 'PAUSED', ['P — resume', 'R — restart the run']);
      } else if (game.screen === 'over') {
        drawOverlay(game, game.plane.message.startsWith('DITCHED') ? 'DITCHED' : 'CRASHED', [
          `Score ${game.plane.score} · rings ${game.plane.ringsPassed}/${game.world.rings.length}`,
          'R — fly again',
        ]);
      } else if (game.screen === 'complete') {
        drawOverlay(game, 'MAIL RUN COMPLETE', [
          `Score ${game.plane.score} · ${game.plane.ringsPassed}/${game.world.rings.length} rings`,
          `Time ${Math.floor(game.plane.time / 60)}:${Math.floor(game.plane.time % 60).toString().padStart(2, '0')} · best ${Math.max(game.best, game.plane.score)}`,
          'R — fly again',
        ]);
      }
    }
  }

  return { render, project };
}
