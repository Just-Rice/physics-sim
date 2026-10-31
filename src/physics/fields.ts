import type { PartInstance } from '../sim/types';

const DRAG_COEFF = 0.8;
const f = { x: 0, y: 0, z: 0 };

/** Smooth pseudo-random gust factor in [-1, 1]. */
export function gustNoise(t: number): number {
  return (Math.sin(t * 1.3) * 0.5 + Math.sin(t * 2.9 + 1.7) * 0.3 + Math.sin(t * 6.1 + 0.4) * 0.2);
}

export function windAt(windX: number, windZ: number, gust: number, t: number): { x: number; y: number; z: number } {
  const k = 1 + gust * gustNoise(t);
  return { x: windX * k, y: 0, z: windZ * k };
}

/**
 * Quadratic air drag relative to the wind: F = -½ ρ C_d A |v_rel| v_rel.
 * Heavy objects barely notice; foam, balloons and fabric drift.
 */
export function applyAirDrag(parts: PartInstance[], airDensity: number, wind: { x: number; y: number; z: number }): void {
  const windy = wind.x !== 0 || wind.z !== 0;
  for (const p of parts) {
    const b = p.body;
    if (!b.isDynamic()) continue;
    if (!windy && b.isSleeping()) continue;
    const v = b.linvel();
    const rx = v.x - wind.x, ry = v.y - wind.y, rz = v.z - wind.z;
    const speed = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (speed < 1e-4) continue;
    const k = -0.5 * airDensity * DRAG_COEFF * p.area * speed;
    f.x = k * rx; f.y = k * ry; f.z = k * rz;
    // Avoid over-damping very light bodies in one step (keeps foam stable).
    const maxF = (b.mass() * speed) / (1 / 120) * 0.5;
    const mag = Math.abs(k) * speed;
    if (mag > maxF) {
      const s = maxF / mag;
      f.x *= s; f.y *= s; f.z *= s;
    }
    b.addForce(f, windy);
  }
}

/** Instant radial impulse with linear falloff. Returns bodies affected. */
export function explode(parts: PartInstance[], cx: number, cy: number, cz: number, strength: number, radius: number): number {
  let n = 0;
  for (const p of parts) {
    const b = p.body;
    if (!b.isDynamic()) continue;
    const c = b.worldCom();
    const dx = c.x - cx, dy = c.y - cy, dz = c.z - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > radius) continue;
    const fall = 1 - d / radius;
    const inv = d > 1e-4 ? 1 / d : 0;
    // Impulse scales with mass^(2/3) so small and big things both fly, but not identically.
    const m = b.mass();
    const mag = strength * fall * Math.pow(m, 0.66) * 1.5;
    const upBias = 0.35;
    b.applyImpulse({ x: dx * inv * mag, y: (dy * inv + upBias) * mag, z: dz * inv * mag }, true);
    b.applyTorqueImpulse({ x: (Math.random() - 0.5) * mag * 0.05, y: (Math.random() - 0.5) * mag * 0.05, z: (Math.random() - 0.5) * mag * 0.05 }, true);
    n++;
  }
  return n;
}
