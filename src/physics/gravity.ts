import type { PartInstance } from '../sim/types';

/**
 * Sandbox gravitational constant. Real G (6.67e-11) is far too weak at human
 * scale, so orbits use G_BASE × the UI multiplier. With G_BASE = 0.01 a
 * 2000 kg "star" holds a planet 5 m away at about 2 m/s.
 */
export const G_BASE = 0.01;
const SOFTENING = 0.05;

export function partMass(p: PartInstance): number {
  if (p.body.isDynamic()) return p.body.mass();
  // Fixed bodies have no dynamic mass; use collider density × volume so they can be gravity sources.
  let m = 0;
  for (const s of p.shapes) if (s.collider) m += s.collider.mass();
  return m;
}

const scratch = { x: 0, y: 0, z: 0 };

/**
 * Every body pulls on every other body (O(n²)). Applied as an impulse at the
 * start of the step ("kick, then drift"), which is symplectic: orbits keep
 * their energy instead of slowly spiralling out.
 */
export function applyNBody(parts: PartInstance[], G: number, dt: number): void {
  const n = parts.length;
  const g = G * G_BASE;
  const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n), m = new Float64Array(n);
  const fx = new Float64Array(n), fy = new Float64Array(n), fz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = parts[i].body.worldCom();
    px[i] = c.x; py[i] = c.y; pz[i] = c.z;
    m[i] = partMass(parts[i]);
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = px[j] - px[i], dy = py[j] - py[i], dz = pz[j] - pz[i];
      const r2 = dx * dx + dy * dy + dz * dz + SOFTENING * SOFTENING;
      const inv = 1 / Math.sqrt(r2);
      const f = (g * m[i] * m[j]) / r2;
      const sx = dx * inv * f, sy = dy * inv * f, sz = dz * inv * f;
      fx[i] += sx; fy[i] += sy; fz[i] += sz;
      fx[j] -= sx; fy[j] -= sy; fz[j] -= sz;
    }
  }
  for (let i = 0; i < n; i++) {
    const b = parts[i].body;
    if (!b.isDynamic()) continue;
    scratch.x = fx[i] * dt; scratch.y = fy[i] * dt; scratch.z = fz[i] * dt;
    b.applyImpulse(scratch, true);
  }
}

/** Only bodies flagged as attractors pull on the others. */
export function applyAttractors(parts: PartInstance[], G: number, dt: number): void {
  const g = G * G_BASE;
  const sources = parts.filter((p) => p.def.attractor);
  if (sources.length === 0) return;
  const src = sources.map((s) => ({ c: s.body.worldCom(), m: partMass(s), part: s }));
  for (const p of parts) {
    const b = p.body;
    if (!b.isDynamic()) continue;
    const c = b.worldCom();
    const mi = b.mass();
    let fx = 0, fy = 0, fz = 0;
    for (const s of src) {
      if (s.part === p) continue;
      const dx = s.c.x - c.x, dy = s.c.y - c.y, dz = s.c.z - c.z;
      const r2 = dx * dx + dy * dy + dz * dz + SOFTENING * SOFTENING;
      const inv = 1 / Math.sqrt(r2);
      const f = (g * s.m * mi) / r2;
      fx += dx * inv * f; fy += dy * inv * f; fz += dz * inv * f;
    }
    scratch.x = fx * dt; scratch.y = fy * dt; scratch.z = fz * dt;
    b.applyImpulse(scratch, true);
  }
}

/** Circular orbit speed around a mass M at distance r. */
export function orbitalSpeed(M: number, r: number, G = 1): number {
  return Math.sqrt((G * G_BASE * M) / r);
}
