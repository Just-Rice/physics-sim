/**
 * Collision proxies for particles. Proxies are plain data (no Rapier calls) so
 * the same code runs on the main thread and inside workers.
 *
 * Record layout in `ProxySet.data` (stride PROXY_STRIDE floats):
 *  0 type, 1-3 position, 4-7 rotation quat (x,y,z,w), 8-11 params,
 *  12-14 aabb min, 15-17 aabb max, 18 friction, 19 body index,
 *  20-22 linear velocity, 23-25 angular velocity, 26-28 centre of mass,
 *  29 extra offset (hull planes / trimesh index), 30 extra count, 31 inverse mass hint
 */
export const PROXY_STRIDE = 32;
export const enum ProxyType {
  Sphere = 0,
  Box = 1,
  Capsule = 2,
  Cylinder = 3,
  Hull = 4,
  Trimesh = 5,
}

export interface TrimeshData {
  vertices: Float32Array;
  indices: Uint32Array;
  /** Uniform grid acceleration (built lazily). */
  grid?: TriGrid;
}

interface TriGrid {
  min: [number, number, number];
  cell: number;
  dims: [number, number, number];
  start: Int32Array;
  items: Int32Array;
}

export class ProxySet {
  data = new Float32Array(PROXY_STRIDE * 64);
  count = 0;
  /** Packed hull planes (nx, ny, nz, d) referenced by hull proxies. */
  planes = new Float32Array(256);
  planeCount = 0;
  trimeshes: TrimeshData[] = [];

  clear(): void {
    this.count = 0;
    this.planeCount = 0;
    this.trimeshes.length = 0;
  }

  push(): number {
    if ((this.count + 1) * PROXY_STRIDE > this.data.length) {
      const n = new Float32Array(this.data.length * 2);
      n.set(this.data);
      this.data = n;
    }
    const o = this.count * PROXY_STRIDE;
    this.data.fill(0, o, o + PROXY_STRIDE);
    this.count++;
    return o;
  }

  addPlanes(p: Float32Array): number {
    const need = (this.planeCount + p.length / 4) * 4;
    if (need > this.planes.length) {
      const n = new Float32Array(Math.max(need, this.planes.length * 2));
      n.set(this.planes);
      this.planes = n;
    }
    const off = this.planeCount;
    this.planes.set(p, off * 4);
    this.planeCount += p.length / 4;
    return off;
  }
}

function buildTriGrid(t: TrimeshData): TriGrid {
  const v = t.vertices, idx = t.indices;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[i + k]);
      max[k] = Math.max(max[k], v[i + k]);
    }
  }
  const triCount = idx.length / 3;
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-3);
  const cell = Math.max(extent / Math.cbrt(Math.max(1, triCount) * 2), 0.05);
  const dims: [number, number, number] = [0, 1, 2].map((k) => Math.max(1, Math.ceil((max[k] - min[k]) / cell) + 1)) as [number, number, number];
  const ncell = dims[0] * dims[1] * dims[2];
  const counts = new Int32Array(ncell + 1);
  const cellsOf = (tri: number, cb: (c: number) => void) => {
    const a = idx[tri * 3] * 3, b = idx[tri * 3 + 1] * 3, c = idx[tri * 3 + 2] * 3;
    const lo = [0, 1, 2].map((k) => Math.floor((Math.min(v[a + k], v[b + k], v[c + k]) - min[k]) / cell));
    const hi = [0, 1, 2].map((k) => Math.floor((Math.max(v[a + k], v[b + k], v[c + k]) - min[k]) / cell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) cb((x * dims[1] + y) * dims[2] + z);
  };
  for (let t2 = 0; t2 < triCount; t2++) cellsOf(t2, (c) => counts[c + 1]++);
  for (let i = 0; i < ncell; i++) counts[i + 1] += counts[i];
  const items = new Int32Array(counts[ncell]);
  const fill = counts.slice(0, ncell);
  for (let t2 = 0; t2 < triCount; t2++) cellsOf(t2, (c) => (items[fill[c]++] = t2));
  return { min, cell, dims, start: counts, items };
}

// Closest point on triangle (Ericson, Real-Time Collision Detection)
function closestOnTri(px: number, py: number, pz: number, v: Float32Array, a: number, b: number, c: number, out: Float64Array): void {
  const ax = v[a], ay = v[a + 1], az = v[a + 2];
  const abx = v[b] - ax, aby = v[b + 1] - ay, abz = v[b + 2] - az;
  const acx = v[c] - ax, acy = v[c + 1] - ay, acz = v[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
  const bpx = px - v[b], bpy = py - v[b + 1], bpz = pz - v[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = v[b]; out[1] = v[b + 1]; out[2] = v[b + 2]; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); out[0] = ax + abx * t; out[1] = ay + aby * t; out[2] = az + abz * t; return; }
  const cpx = px - v[c], cpy = py - v[c + 1], cpz = pz - v[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = v[c]; out[1] = v[c + 1]; out[2] = v[c + 2]; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); out[0] = ax + acx * t; out[1] = ay + acy * t; out[2] = az + acz * t; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = v[b] + (v[c] - v[b]) * t; out[1] = v[b + 1] + (v[c + 1] - v[b + 1]) * t; out[2] = v[b + 2] + (v[c + 2] - v[b + 2]) * t; return;
  }
  const denom = 1 / (va + vb + vc);
  const s = vb * denom, t = vc * denom;
  out[0] = ax + abx * s + acx * t; out[1] = ay + aby * s + acy * t; out[2] = az + abz * s + acz * t;
}

const tri = new Float64Array(3);

/**
 * Signed distance from a local-space point to a proxy surface. Writes the
 * outward local normal into `n` and returns the distance (negative inside).
 * Returns +Infinity if the point is clearly far away.
 */
export function proxyDistance(set: ProxySet, o: number, x: number, y: number, z: number, n: Float64Array, maxDist: number): number {
  const d = set.data;
  switch (d[o] as ProxyType) {
    case ProxyType.Sphere: {
      const r = d[o + 8];
      const len = Math.sqrt(x * x + y * y + z * z);
      if (len < 1e-9) { n[0] = 0; n[1] = 1; n[2] = 0; return -r; }
      n[0] = x / len; n[1] = y / len; n[2] = z / len;
      return len - r;
    }
    case ProxyType.Box: {
      const hx = d[o + 8], hy = d[o + 9], hz = d[o + 10];
      const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
      if (qx > 0 || qy > 0 || qz > 0) {
        const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
        const len = Math.sqrt(mx * mx + my * my + mz * mz);
        if (len < 1e-9) { n[0] = 0; n[1] = 1; n[2] = 0; return 0; }
        n[0] = (mx / len) * Math.sign(x); n[1] = (my / len) * Math.sign(y); n[2] = (mz / len) * Math.sign(z);
        return len;
      }
      // Inside: push out through the nearest face.
      if (qx >= qy && qx >= qz) { n[0] = Math.sign(x) || 1; n[1] = 0; n[2] = 0; return qx; }
      if (qy >= qz) { n[0] = 0; n[1] = Math.sign(y) || 1; n[2] = 0; return qy; }
      n[0] = 0; n[1] = 0; n[2] = Math.sign(z) || 1; return qz;
    }
    case ProxyType.Capsule: {
      const r = d[o + 8], hh = d[o + 9];
      const cy = Math.max(-hh, Math.min(hh, y));
      const dx = x, dy = y - cy, dz = z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) { n[0] = 1; n[1] = 0; n[2] = 0; return -r; }
      n[0] = dx / len; n[1] = dy / len; n[2] = dz / len;
      return len - r;
    }
    case ProxyType.Cylinder: {
      const r = d[o + 8], hh = d[o + 9];
      const rad = Math.sqrt(x * x + z * z);
      const dr = rad - r, dy = Math.abs(y) - hh;
      if (dr > 0 && dy > 0) {
        const len = Math.sqrt(dr * dr + dy * dy);
        n[0] = rad > 1e-9 ? (x / rad) * (dr / len) : 0; n[1] = Math.sign(y) * (dy / len); n[2] = rad > 1e-9 ? (z / rad) * (dr / len) : 0;
        return len;
      }
      if (dr > dy) {
        if (rad < 1e-9) { n[0] = 1; n[1] = 0; n[2] = 0; } else { n[0] = x / rad; n[1] = 0; n[2] = z / rad; }
        return dr;
      }
      n[0] = 0; n[1] = Math.sign(y) || 1; n[2] = 0;
      return dy;
    }
    case ProxyType.Hull: {
      const off = d[o + 29] * 4, cnt = d[o + 30];
      const p = set.planes;
      let best = -Infinity;
      let bi = off;
      for (let i = 0; i < cnt; i++) {
        const k = off + i * 4;
        const s = p[k] * x + p[k + 1] * y + p[k + 2] * z + p[k + 3];
        if (s > best) { best = s; bi = k; }
        if (best > maxDist) return Infinity;
      }
      n[0] = p[bi]; n[1] = p[bi + 1]; n[2] = p[bi + 2];
      return best;
    }
    case ProxyType.Trimesh: {
      const t = set.trimeshes[d[o + 29]];
      if (!t) return Infinity;
      if (!t.grid) t.grid = buildTriGrid(t);
      const g = t.grid;
      const v = t.vertices, idx = t.indices;
      const cx = Math.floor((x - g.min[0]) / g.cell), cy = Math.floor((y - g.min[1]) / g.cell), cz = Math.floor((z - g.min[2]) / g.cell);
      let bestD2 = maxDist * maxDist;
      let found = false;
      let bx = 0, by = 0, bz = 0, btri = -1;
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        if (ix < 0 || ix >= g.dims[0]) continue;
        for (let iy = cy - 1; iy <= cy + 1; iy++) {
          if (iy < 0 || iy >= g.dims[1]) continue;
          for (let iz = cz - 1; iz <= cz + 1; iz++) {
            if (iz < 0 || iz >= g.dims[2]) continue;
            const c = (ix * g.dims[1] + iy) * g.dims[2] + iz;
            for (let k = g.start[c]; k < g.start[c + 1]; k++) {
              const ti = g.items[k];
              closestOnTri(x, y, z, v, idx[ti * 3] * 3, idx[ti * 3 + 1] * 3, idx[ti * 3 + 2] * 3, tri);
              const dx = x - tri[0], dy = y - tri[1], dz = z - tri[2];
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < bestD2) { bestD2 = d2; bx = tri[0]; by = tri[1]; bz = tri[2]; btri = ti; found = true; }
            }
          }
        }
      }
      if (!found) return Infinity;
      // Face normal decides which side we're on (trimesh is a thin shell).
      const a = idx[btri * 3] * 3, b = idx[btri * 3 + 1] * 3, c = idx[btri * 3 + 2] * 3;
      const e1x = v[b] - v[a], e1y = v[b + 1] - v[a + 1], e1z = v[b + 2] - v[a + 2];
      const e2x = v[c] - v[a], e2y = v[c + 1] - v[a + 1], e2z = v[c + 2] - v[a + 2];
      let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
      const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
      const dist = Math.sqrt(bestD2);
      const side = (x - bx) * fx + (y - by) * fy + (z - bz) * fz;
      // The shell is two-sided: the normal points from the surface towards the particle.
      if (dist > 1e-6) {
        n[0] = (x - bx) / dist; n[1] = (y - by) / dist; n[2] = (z - bz) / dist;
      } else {
        const s = side < 0 ? -1 : 1;
        n[0] = fx * s; n[1] = fy * s; n[2] = fz * s;
      }
      return dist;
    }
  }
  return Infinity;
}
