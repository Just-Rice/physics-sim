import { PROXY_STRIDE, ProxySet, proxyDistance } from './collision';

/**
 * Unified XPBD particle solver for cloth, soft bodies and fluids
 * ("small steps": many substeps with one constraint iteration each).
 *
 * Everything lives in flat typed arrays so the hot loops are cheap and the
 * same data can be shared with workers (see scheduler.ts).
 */

export const FLAG_FLUID = 1;
export const FLAG_CLOTH = 2;
export const FLAG_SOFT = 4;
export const FLAG_GRABBED = 16;

export const FLUID_PHASE = -1;
const MAX_NEIGHBORS = 48;
const MAX_SPEED = 35;

export interface SoftBodyData {
  start: number;
  count: number;
  /** Global particle indices, 3 per triangle (outward CCW). */
  triangles: Int32Array;
  restVolume: number;
  pressure: number;
  volumeCompliance: number;
  shapeMatching: number;
  /** Rest positions relative to the rest centre of mass. */
  restOffsets: Float32Array;
  rot: Float64Array; // quaternion x,y,z,w for shape matching
  grads: Float32Array;
}

export interface ClothData {
  start: number;
  count: number;
  triangles: Int32Array;
  /** Distance constraint range belonging to this cloth. */
  cStart: number;
  cCount: number;
}

export interface SoftConstraintRange {
  start: number;
  count: number;
  cStart: number;
  cCount: number;
}

export interface Attachment {
  particle: number;
  /** Body slot this particle follows (-1 = fixed in the world). */
  slot: number;
  /** Local point on the body (or world point when slot = -1). */
  local: [number, number, number];
}

export interface Emitter {
  owner: number;
  position: [number, number, number];
  velocity: [number, number, number];
  radius: number;
  rate: number;
  remaining: number;
  viscosity: number;
  acc: number;
}

export interface StepOptions {
  dt: number;
  substeps: number;
  fluidIterations: number;
  gravity: [number, number, number];
  wind: [number, number, number];
  airDensity: number;
  ground: boolean;
  proxies: ProxySet;
  /** 7 floats per body slot: position + quaternion (for attachments). */
  bodyPoses: Float32Array;
  /** Output: 6 floats per body slot (linear impulse, angular impulse). */
  impulses: Float64Array;
  /** Body slot centre of mass (3 per slot) for torque. */
  bodyCom: Float32Array;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export class ParticleWorld {
  capacity = 0;
  count = 0;
  pos = new Float32Array(0);
  prev = new Float32Array(0);
  vel = new Float32Array(0);
  invMass = new Float32Array(0);
  mass = new Float32Array(0);
  radius = new Float32Array(0);
  friction = new Float32Array(0);
  phase = new Int32Array(0);
  flags = new Uint8Array(0);
  viscosity = new Float32Array(0);
  /** Owning soft object id (for removal). */
  owner = new Int32Array(0);
  lambda = new Float32Array(0);
  /** Distance and normal to the nearest solid surface (fluid boundary density). */
  wallD = new Float32Array(0);
  wallN = new Float32Array(0);
  delta = new Float32Array(0);
  deltaCount = new Uint16Array(0);
  neighbors = new Int32Array(0);
  nCount = new Int32Array(0);
  private cellOf = new Int32Array(0);
  private sorted = new Int32Array(0);
  private cellStart = new Int32Array(0);
  private tableSize = 0;
  private cursor = new Int32Array(0);

  // Distance constraints
  cA = new Int32Array(0);
  cB = new Int32Array(0);
  cRest = new Float32Array(0);
  cCompliance = new Float32Array(0);
  cLambda = new Float32Array(0);
  cCount = 0;

  softBodies: SoftBodyData[] = [];
  cloths: ClothData[] = [];
  /** Distance-constraint ranges for every soft object (cloth or soft body). */
  ranges: SoftConstraintRange[] = [];
  attachments: Attachment[] = [];
  emitters: Emitter[] = [];
  private grabs = new Map<number, { particle: number; target: [number, number, number]; invMass: number }>();
  private grabId = 1;

  // Fluid kernel
  fluidRadius = 0.04;
  H = 0.16;
  private poly6 = 0;
  private spiky = 0;
  private rho0 = 1;
  /** Boundary density ρ_w(d) and dρ_w/dd tabulated over d ∈ [0, H]. */
  private wallRho = new Float32Array(33);
  private wallGrad = new Float32Array(33);
  private epsilon = 1;
  fluidCount = 0;

  private nScratch = new Float64Array(3);
  private rand = 12345;

  constructor(capacity = 4096) {
    this.ensureCapacity(capacity);
    this.setFluidRadius(0.04);
  }

  private random(): number {
    this.rand = (this.rand * 1664525 + 1013904223) >>> 0;
    return this.rand / 4294967296;
  }

  setFluidRadius(r: number): void {
    this.fluidRadius = r;
    const d = 2 * r;
    const H = 2 * d;
    this.H = H;
    this.poly6 = 315 / (64 * Math.PI * Math.pow(H, 9));
    this.spiky = 45 / (Math.PI * Math.pow(H, 6));
    // Rest density and constraint scale from a perfect lattice at the rest spacing.
    let rho = 0;
    let g2 = 0;
    const n = Math.ceil(H / d) + 1;
    for (let x = -n; x <= n; x++) for (let y = -n; y <= n; y++) for (let z = -n; z <= n; z++) {
      const rr = Math.sqrt(x * x + y * y + z * z) * d;
      if (rr >= H) continue;
      rho += this.W(rr * rr);
      if (rr > 0) {
        const g = this.spiky * (H - rr) * (H - rr);
        g2 += g * g;
      }
    }
    this.rho0 = rho;
    // Relaxation keeps the solve soft enough to be stable.
    this.epsilon = (g2 / (rho * rho)) * 0.04;
    // Planar wall made of lattice particles continuing the fluid below the surface:
    // a particle resting at d = r sees the same density as one inside the fluid.
    for (let s = 0; s <= 32; s++) {
      const dd = (s / 32) * H;
      let wr = 0;
      for (let x = -n; x <= n; x++) for (let z = -n; z <= n; z++) for (let k = 0; k <= n; k++) {
        const by = -d / 2 - k * d;
        const dx = x * d, dy = dd - by, dz = z * d;
        wr += this.W(dx * dx + dy * dy + dz * dz);
      }
      this.wallRho[s] = wr;
    }
    for (let s = 0; s <= 32; s++) {
      const a = this.wallRho[Math.max(0, s - 1)], b = this.wallRho[Math.min(32, s + 1)];
      this.wallGrad[s] = (b - a) / (((Math.min(32, s + 1) - Math.max(0, s - 1)) / 32) * H);
    }
    for (let i = 0; i < this.count; i++) if (this.flags[i] & FLAG_FLUID) this.radius[i] = r;
  }

  private W(r2: number): number {
    const h2 = this.H * this.H;
    if (r2 >= h2) return 0;
    const t = h2 - r2;
    return this.poly6 * t * t * t;
  }

  ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    const cap = Math.max(n, Math.ceil(this.capacity * 1.5), 1024);
    const grow = <T extends Float32Array | Int32Array | Uint8Array | Uint16Array>(a: T, size: number): T => {
      const b = new (a.constructor as new (n: number) => T)(size);
      b.set(a.subarray(0, Math.min(a.length, size)) as never);
      return b;
    };
    this.pos = grow(this.pos, cap * 3);
    this.prev = grow(this.prev, cap * 3);
    this.vel = grow(this.vel, cap * 3);
    this.invMass = grow(this.invMass, cap);
    this.mass = grow(this.mass, cap);
    this.radius = grow(this.radius, cap);
    this.friction = grow(this.friction, cap);
    this.phase = grow(this.phase, cap);
    this.flags = grow(this.flags, cap);
    this.viscosity = grow(this.viscosity, cap);
    this.owner = grow(this.owner, cap);
    this.lambda = new Float32Array(cap);
    this.wallD = new Float32Array(cap).fill(1e9);
    this.wallN = new Float32Array(cap * 3);
    this.delta = new Float32Array(cap * 3);
    this.deltaCount = new Uint16Array(cap);
    this.neighbors = new Int32Array(cap * MAX_NEIGHBORS);
    this.nCount = new Int32Array(cap);
    this.cellOf = new Int32Array(cap);
    this.sorted = new Int32Array(cap);
    this.capacity = cap;
  }

  private ensureConstraints(n: number): void {
    if (n <= this.cA.length) return;
    const cap = Math.max(n, this.cA.length * 2, 1024);
    const grow = <T extends Float32Array | Int32Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(cap);
      b.set(a as never);
      return b;
    };
    this.cA = grow(this.cA);
    this.cB = grow(this.cB);
    this.cRest = grow(this.cRest);
    this.cCompliance = grow(this.cCompliance);
    this.cLambda = grow(this.cLambda);
  }

  /** Append particles. Returns the index of the first new particle. */
  addParticles(n: number, init: (k: number, i: number) => void): number {
    this.ensureCapacity(this.count + n);
    const start = this.count;
    for (let k = 0; k < n; k++) {
      const i = start + k;
      this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
      this.friction[i] = 0.5;
      this.viscosity[i] = 0;
      this.flags[i] = 0;
      init(k, i);
      this.prev[i * 3] = this.pos[i * 3];
      this.prev[i * 3 + 1] = this.pos[i * 3 + 1];
      this.prev[i * 3 + 2] = this.pos[i * 3 + 2];
      if (this.flags[i] & FLAG_FLUID) this.fluidCount++;
    }
    this.count += n;
    return start;
  }

  addDistance(a: number, b: number, compliance: number, rest?: number): void {
    this.ensureConstraints(this.cCount + 1);
    const c = this.cCount++;
    this.cA[c] = a;
    this.cB[c] = b;
    if (rest === undefined) {
      const dx = this.pos[a * 3] - this.pos[b * 3], dy = this.pos[a * 3 + 1] - this.pos[b * 3 + 1], dz = this.pos[a * 3 + 2] - this.pos[b * 3 + 2];
      rest = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    this.cRest[c] = rest;
    this.cCompliance[c] = compliance;
  }

  /** Remove every particle owned by `owner` and everything that references them. */
  removeOwner(owner: number): void {
    const n = this.count;
    const map = new Int32Array(n);
    let w = 0;
    for (let i = 0; i < n; i++) {
      if (this.owner[i] === owner) {
        map[i] = -1;
        if (this.flags[i] & FLAG_FLUID) this.fluidCount--;
        continue;
      }
      map[i] = w;
      if (w !== i) {
        for (let k = 0; k < 3; k++) {
          this.pos[w * 3 + k] = this.pos[i * 3 + k];
          this.prev[w * 3 + k] = this.prev[i * 3 + k];
          this.vel[w * 3 + k] = this.vel[i * 3 + k];
        }
        this.invMass[w] = this.invMass[i]; this.mass[w] = this.mass[i]; this.radius[w] = this.radius[i];
        this.friction[w] = this.friction[i]; this.phase[w] = this.phase[i]; this.flags[w] = this.flags[i];
        this.viscosity[w] = this.viscosity[i]; this.owner[w] = this.owner[i];
      }
      w++;
    }
    this.count = w;
    // Constraints (stored contiguously per object)
    const cmap = new Int32Array(this.cCount);
    let cw = 0;
    for (let c = 0; c < this.cCount; c++) {
      const a = map[this.cA[c]], b = map[this.cB[c]];
      if (a < 0 || b < 0) { cmap[c] = -1; continue; }
      cmap[c] = cw;
      this.cA[cw] = a; this.cB[cw] = b; this.cRest[cw] = this.cRest[c]; this.cCompliance[cw] = this.cCompliance[c];
      cw++;
    }
    this.cCount = cw;
    const remapTris = (t: Int32Array) => { for (let k = 0; k < t.length; k++) t[k] = map[t[k]]; };
    const fixRange = <T extends { start: number; cStart?: number; cCount?: number }>(arr: T[]) => arr.filter((r) => {
      if (map[r.start] < 0) return false;
      r.start = map[r.start];
      if (r.cStart !== undefined && r.cCount) r.cStart = cmap[r.cStart] >= 0 ? cmap[r.cStart] : 0;
      return true;
    });
    this.ranges = fixRange(this.ranges);
    this.cloths = fixRange(this.cloths);
    for (const c of this.cloths) remapTris(c.triangles);
    this.softBodies = this.softBodies.filter((sb) => {
      if (map[sb.start] < 0) return false;
      sb.start = map[sb.start];
      remapTris(sb.triangles);
      return true;
    });
    this.attachments = this.attachments.filter((a) => (a.particle = map[a.particle]) >= 0);
    this.emitters = this.emitters.filter((e) => e.owner !== owner);
    for (const [id, g] of this.grabs) {
      g.particle = map[g.particle];
      if (g.particle < 0) this.grabs.delete(id);
    }
  }

  clear(): void {
    this.count = 0;
    this.cCount = 0;
    this.fluidCount = 0;
    this.softBodies = [];
    this.cloths = [];
    this.ranges = [];
    this.attachments = [];
    this.emitters = [];
    this.grabs.clear();
  }

  // ------------------------------------------------------------------ interaction

  grab(particle: number): number {
    const id = this.grabId++;
    const p = this.pos;
    this.grabs.set(id, { particle, target: [p[particle * 3], p[particle * 3 + 1], p[particle * 3 + 2]], invMass: this.invMass[particle] });
    this.flags[particle] |= FLAG_GRABBED;
    return id;
  }

  moveGrab(id: number, x: number, y: number, z: number): void {
    const g = this.grabs.get(id);
    if (g) g.target = [x, y, z];
  }

  release(id: number): void {
    const g = this.grabs.get(id);
    if (!g) return;
    this.flags[g.particle] &= ~FLAG_GRABBED;
    this.grabs.delete(id);
  }

  nearestParticle(x: number, y: number, z: number, start: number, count: number): number {
    let best = -1, bd = Infinity;
    for (let i = start; i < start + count; i++) {
      const dx = this.pos[i * 3] - x, dy = this.pos[i * 3 + 1] - y, dz = this.pos[i * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  impulseRadial(cx: number, cy: number, cz: number, strength: number, radius: number, attract: boolean, dt = 1): void {
    for (let i = 0; i < this.count; i++) {
      if (this.invMass[i] === 0) continue;
      const dx = this.pos[i * 3] - cx, dy = this.pos[i * 3 + 1] - cy, dz = this.pos[i * 3 + 2] - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > radius || d < 1e-5) continue;
      const fall = 1 - d / radius;
      const s = attract ? (-strength * fall * dt) / Math.max(d, 0.5) : strength * fall * 0.35;
      this.vel[i * 3] += (dx / d) * s;
      this.vel[i * 3 + 1] += (dy / d) * s + (attract ? 0 : 0.3 * strength * fall * 0.35);
      this.vel[i * 3 + 2] += (dz / d) * s;
    }
  }

  // ------------------------------------------------------------------ neighbour search

  private hash(ix: number, iy: number, iz: number): number {
    return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & (this.tableSize - 1);
  }

  buildNeighbors(): void {
    const n = this.count;
    const ts = nextPow2(Math.max(64, n * 2));
    if (ts !== this.tableSize) {
      this.tableSize = ts;
      this.cellStart = new Int32Array(ts + 1);
    }
    const cs = this.cellStart;
    cs.fill(0);
    const H = this.H;
    const inv = 1 / H;
    const p = this.pos;
    for (let i = 0; i < n; i++) {
      const h = this.hash(Math.floor(p[i * 3] * inv), Math.floor(p[i * 3 + 1] * inv), Math.floor(p[i * 3 + 2] * inv));
      this.cellOf[i] = h;
      cs[h + 1]++;
    }
    for (let i = 0; i < ts; i++) cs[i + 1] += cs[i];
    if (this.cursor.length !== ts) this.cursor = new Int32Array(ts);
    const cursor = this.cursor;
    cursor.fill(0);
    for (let i = 0; i < n; i++) {
      const h = this.cellOf[i];
      this.sorted[cs[h] + cursor[h]++] = i;
    }
    this.findNeighbors(0, n);
  }

  /** Neighbour lists for particles [from, to). Independent per particle. */
  findNeighbors(from: number, to: number): void {
    const H = this.H, H2 = H * H, inv = 1 / H;
    const p = this.pos, nb = this.neighbors, nc = this.nCount, cs = this.cellStart, sorted = this.sorted;
    const seen = new Int32Array(27);
    for (let i = from; i < to; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      const ix = Math.floor(x * inv), iy = Math.floor(y * inv), iz = Math.floor(z * inv);
      let cnt = 0;
      let seenN = 0;
      const base = i * MAX_NEIGHBORS;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const h = this.hash(ix + dx, iy + dy, iz + dz);
        // Hash collisions can map two neighbouring cells to the same bucket.
        let dup = false;
        for (let s = 0; s < seenN; s++) if (seen[s] === h) { dup = true; break; }
        if (dup) continue;
        seen[seenN++] = h;
        for (let k = cs[h]; k < cs[h + 1]; k++) {
          const j = sorted[k];
          if (j === i) continue;
          const ax = p[j * 3] - x, ay = p[j * 3 + 1] - y, az = p[j * 3 + 2] - z;
          if (ax * ax + ay * ay + az * az < H2 && cnt < MAX_NEIGHBORS) nb[base + cnt++] = j;
        }
      }
      nc[i] = cnt;
    }
  }

  // ------------------------------------------------------------------ kernels (range based)

  predict(from: number, to: number, h: number, gx: number, gy: number, gz: number): void {
    const p = this.pos, pr = this.prev, v = this.vel, w = this.invMass, f = this.flags;
    for (let i = from; i < to; i++) {
      const k = i * 3;
      pr[k] = p[k]; pr[k + 1] = p[k + 1]; pr[k + 2] = p[k + 2];
      if (w[i] === 0 || f[i] & FLAG_GRABBED) continue;
      v[k] += gx * h; v[k + 1] += gy * h; v[k + 2] += gz * h;
      p[k] += v[k] * h; p[k + 1] += v[k + 1] * h; p[k + 2] += v[k + 2] * h;
    }
  }

  /** Gauss–Seidel XPBD distance constraints in [cFrom, cTo). */
  solveDistance(cFrom: number, cTo: number, h: number): void {
    const p = this.pos, w = this.invMass, f = this.flags;
    const A = this.cA, B = this.cB, R = this.cRest, Cc = this.cCompliance, L = this.cLambda;
    const ih2 = 1 / (h * h);
    for (let c = cFrom; c < cTo; c++) {
      const a = A[c], b = B[c];
      const wa = f[a] & FLAG_GRABBED ? 0 : w[a], wb = f[b] & FLAG_GRABBED ? 0 : w[b];
      const ws = wa + wb;
      if (ws === 0) continue;
      const dx = p[a * 3] - p[b * 3], dy = p[a * 3 + 1] - p[b * 3 + 1], dz = p[a * 3 + 2] - p[b * 3 + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const C = len - R[c];
      const at = Cc[c] * ih2;
      const dl = (-C - at * L[c]) / (ws + at);
      L[c] += dl;
      const s = dl / len;
      p[a * 3] += wa * s * dx; p[a * 3 + 1] += wa * s * dy; p[a * 3 + 2] += wa * s * dz;
      p[b * 3] -= wb * s * dx; p[b * 3 + 1] -= wb * s * dy; p[b * 3 + 2] -= wb * s * dz;
    }
  }

  solveVolume(sb: SoftBodyData, h: number, lambda: { v: number }): void {
    const p = this.pos, w = this.invMass, t = sb.triangles, g = sb.grads;
    g.fill(0);
    let V = 0;
    const s0 = sb.start;
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      V += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
      const ga = (t[k] - s0) * 3, gb = (t[k + 1] - s0) * 3, gc = (t[k + 2] - s0) * 3;
      g[ga] += (by * cz - bz * cy) / 6; g[ga + 1] += (bz * cx - bx * cz) / 6; g[ga + 2] += (bx * cy - by * cx) / 6;
      g[gb] += (cy * az - cz * ay) / 6; g[gb + 1] += (cz * ax - cx * az) / 6; g[gb + 2] += (cx * ay - cy * ax) / 6;
      g[gc] += (ay * bz - az * by) / 6; g[gc + 1] += (az * bx - ax * bz) / 6; g[gc + 2] += (ax * by - ay * bx) / 6;
    }
    const C = V - sb.pressure * sb.restVolume;
    let denom = 0;
    for (let i = 0; i < sb.count; i++) {
      const wi = this.flags[s0 + i] & FLAG_GRABBED ? 0 : w[s0 + i];
      denom += wi * (g[i * 3] ** 2 + g[i * 3 + 1] ** 2 + g[i * 3 + 2] ** 2);
    }
    const at = sb.volumeCompliance / (h * h);
    if (denom + at < 1e-12) return;
    const dl = (-C - at * lambda.v) / (denom + at);
    lambda.v += dl;
    for (let i = 0; i < sb.count; i++) {
      const pi = (s0 + i) * 3;
      const wi = this.flags[s0 + i] & FLAG_GRABBED ? 0 : w[s0 + i];
      p[pi] += wi * dl * g[i * 3]; p[pi + 1] += wi * dl * g[i * 3 + 1]; p[pi + 2] += wi * dl * g[i * 3 + 2];
    }
  }

  solveShapeMatching(sb: SoftBodyData, stiffness: number): void {
    if (stiffness <= 0) return;
    const p = this.pos, s0 = sb.start, n = sb.count, q0 = sb.restOffsets;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += p[(s0 + i) * 3]; cy += p[(s0 + i) * 3 + 1]; cz += p[(s0 + i) * 3 + 2]; }
    cx /= n; cy /= n; cz /= n;
    // A = Σ (x - c) q^T, stored column-major as columns a0, a1, a2
    let a00 = 0, a01 = 0, a02 = 0, a10 = 0, a11 = 0, a12 = 0, a20 = 0, a21 = 0, a22 = 0;
    for (let i = 0; i < n; i++) {
      const px = p[(s0 + i) * 3] - cx, py = p[(s0 + i) * 3 + 1] - cy, pz = p[(s0 + i) * 3 + 2] - cz;
      const qx = q0[i * 3], qy = q0[i * 3 + 1], qz = q0[i * 3 + 2];
      a00 += px * qx; a01 += px * qy; a02 += px * qz;
      a10 += py * qx; a11 += py * qy; a12 += py * qz;
      a20 += pz * qx; a21 += pz * qy; a22 += pz * qz;
    }
    // Iterative rotation extraction (Müller et al. 2016)
    const q = sb.rot;
    for (let it = 0; it < 8; it++) {
      const [x, y, z, w] = q;
      const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - z * w), r02 = 2 * (x * z + y * w);
      const r10 = 2 * (x * y + z * w), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - x * w);
      const r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y);
      // omega = Σ_k R_col_k × A_col_k / |Σ R_col_k · A_col_k|
      const ox = (r10 * a20 - r20 * a10) + (r11 * a21 - r21 * a11) + (r12 * a22 - r22 * a12);
      const oy = (r20 * a00 - r00 * a20) + (r21 * a01 - r01 * a21) + (r22 * a02 - r02 * a22);
      const oz = (r00 * a10 - r10 * a00) + (r01 * a11 - r11 * a01) + (r02 * a12 - r12 * a02);
      const dot = r00 * a00 + r10 * a10 + r20 * a20 + r01 * a01 + r11 * a11 + r21 * a21 + r02 * a02 + r12 * a12 + r22 * a22;
      const s = 1 / (Math.abs(dot) + 1e-9);
      const wx = ox * s, wy = oy * s, wz = oz * s;
      const ang = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (ang < 1e-9) break;
      const ha = ang * 0.5, sn = Math.sin(ha) / ang;
      const dx = wx * sn, dy = wy * sn, dz = wz * sn, dw = Math.cos(ha);
      // q = dq * q
      const nx = dw * x + dx * w + dy * z - dz * y;
      const ny = dw * y - dx * z + dy * w + dz * x;
      const nz = dw * z + dx * y - dy * x + dz * w;
      const nw = dw * w - dx * x - dy * y - dz * z;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
      q[0] = nx / l; q[1] = ny / l; q[2] = nz / l; q[3] = nw / l;
    }
    const [x, y, z, w] = q;
    const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - z * w), r02 = 2 * (x * z + y * w);
    const r10 = 2 * (x * y + z * w), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - x * w);
    const r20 = 2 * (x * z - y * w), r21 = 2 * (y * z + x * w), r22 = 1 - 2 * (x * x + y * y);
    for (let i = 0; i < n; i++) {
      const pi = (s0 + i) * 3;
      if (this.invMass[s0 + i] === 0 || this.flags[s0 + i] & FLAG_GRABBED) continue;
      const qx = q0[i * 3], qy = q0[i * 3 + 1], qz = q0[i * 3 + 2];
      const gx = r00 * qx + r01 * qy + r02 * qz + cx;
      const gy = r10 * qx + r11 * qy + r12 * qz + cy;
      const gz = r20 * qx + r21 * qy + r22 * qz + cz;
      p[pi] += (gx - p[pi]) * stiffness;
      p[pi + 1] += (gy - p[pi + 1]) * stiffness;
      p[pi + 2] += (gz - p[pi + 2]) * stiffness;
    }
  }

  /** Fluid density constraint: λ for fluid particles in [from, to). */
  fluidLambda(from: number, to: number): void {
    const p = this.pos, nb = this.neighbors, nc = this.nCount, f = this.flags, lam = this.lambda;
    const H = this.H, H2 = H * H, rho0 = this.rho0, spiky = this.spiky, eps = this.epsilon;
    const W0 = this.W(0);
    for (let i = from; i < to; i++) {
      if (!(f[i] & FLAG_FLUID)) continue;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      let rho = W0;
      let gx = 0, gy = 0, gz = 0, g2 = 0;
      const base = i * MAX_NEIGHBORS;
      for (let k = 0; k < nc[i]; k++) {
        const j = nb[base + k];
        const dx = x - p[j * 3], dy = y - p[j * 3 + 1], dz = z - p[j * 3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= H2) continue;
        if (f[j] & FLAG_FLUID) {
          const t = H2 - r2;
          rho += this.poly6 * t * t * t;
        } else {
          // Solid particles count as boundary mass so water doesn't leak through cloth.
          const t = H2 - r2;
          rho += this.poly6 * t * t * t * 0.5;
        }
        const r = Math.sqrt(r2);
        if (r < 1e-9) continue;
        const s = (spiky * (H - r) * (H - r)) / (r * rho0);
        const sx = dx * s, sy = dy * s, sz = dz * s;
        gx += sx; gy += sy; gz += sz;
        if (f[j] & FLAG_FLUID) g2 += sx * sx + sy * sy + sz * sz;
      }
      const wd = this.wallD[i];
      if (wd < H) {
        const s = Math.max(0, Math.min(32, (wd / H) * 32));
        const k0 = Math.floor(s), k1 = Math.min(32, k0 + 1), f = s - k0;
        rho += this.wallRho[k0] * (1 - f) + this.wallRho[k1] * f;
        const gw = (this.wallGrad[k0] * (1 - f) + this.wallGrad[k1] * f) / rho0;
        // gradient of the wall density w.r.t. x_i points along the wall normal
        gx += -gw * this.wallN[i * 3]; gy += -gw * this.wallN[i * 3 + 1]; gz += -gw * this.wallN[i * 3 + 2];
      }
      const C = Math.max(rho / rho0 - 1, 0);
      lam[i] = -C / (g2 + gx * gx + gy * gy + gz * gz + eps);
    }
  }

  /** Position delta for fluid particles in [from, to) from current λ (Jacobi). */
  fluidDelta(from: number, to: number): void {
    const p = this.pos, nb = this.neighbors, nc = this.nCount, f = this.flags, lam = this.lambda, d = this.delta;
    const H = this.H, H2 = H * H, rho0 = this.rho0, spiky = this.spiky;
    for (let i = from; i < to; i++) {
      d[i * 3] = d[i * 3 + 1] = d[i * 3 + 2] = 0;
      if (!(f[i] & FLAG_FLUID)) continue;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      const li = lam[i];
      let ax = 0, ay = 0, az = 0;
      const base = i * MAX_NEIGHBORS;
      for (let k = 0; k < nc[i]; k++) {
        const j = nb[base + k];
        const dx = x - p[j * 3], dy = y - p[j * 3 + 1], dz = z - p[j * 3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= H2) continue;
        const r = Math.sqrt(r2);
        if (r < 1e-9) continue;
        const lj = f[j] & FLAG_FLUID ? lam[j] : li;
        const s = ((li + lj) * spiky * (H - r) * (H - r)) / (r * rho0);
        ax += dx * s; ay += dy * s; az += dz * s;
      }
      const wd = this.wallD[i];
      if (wd < H) {
        const s = Math.max(0, Math.min(32, (wd / H) * 32));
        const k0 = Math.floor(s), k1 = Math.min(32, k0 + 1), fr = s - k0;
        const gw = (this.wallGrad[k0] * (1 - fr) + this.wallGrad[k1] * fr) / rho0;
        // ax accumulates -∇W (see above), so the wall term enters with a minus sign.
        const sw = 2 * li * gw;
        ax -= sw * this.wallN[i * 3]; ay -= sw * this.wallN[i * 3 + 1]; az -= sw * this.wallN[i * 3 + 2];
      }
      // λ is negative under compression, so -s pushes particles apart.
      d[i * 3] = -ax; d[i * 3 + 1] = -ay; d[i * 3 + 2] = -az;
    }
  }

  applyFluidDelta(from: number, to: number): void {
    const p = this.pos, d = this.delta, f = this.flags, w = this.invMass;
    for (let i = from; i < to; i++) {
      if (!(f[i] & FLAG_FLUID) || w[i] === 0) continue;
      p[i * 3] += d[i * 3]; p[i * 3 + 1] += d[i * 3 + 1]; p[i * 3 + 2] += d[i * 3 + 2];
    }
  }

  /** Particle–particle contacts between different objects (Jacobi; per-particle share). */
  contacts(from: number, to: number): void {
    const p = this.pos, nb = this.neighbors, nc = this.nCount, f = this.flags, ph = this.phase, w = this.invMass, r = this.radius, d = this.delta;
    for (let i = from; i < to; i++) {
      d[i * 3] = d[i * 3 + 1] = d[i * 3 + 2] = 0;
      const wi = f[i] & FLAG_GRABBED ? 0 : w[i];
      if (wi === 0) continue;
      const fi = f[i] & FLAG_FLUID;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      let ax = 0, ay = 0, az = 0, cnt = 0;
      const base = i * MAX_NEIGHBORS;
      for (let k = 0; k < nc[i]; k++) {
        const j = nb[base + k];
        if (ph[j] === ph[i]) continue;
        if (fi && f[j] & FLAG_FLUID) continue;
        const rr = r[i] + r[j];
        const dx = x - p[j * 3], dy = y - p[j * 3 + 1], dz = z - p[j * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-12) continue;
        const dist = Math.sqrt(d2);
        const wj = f[j] & FLAG_GRABBED ? 0 : w[j];
        const s = ((rr - dist) / dist) * (wi / (wi + wj));
        ax += dx * s; ay += dy * s; az += dz * s;
        cnt++;
      }
      if (cnt) {
        d[i * 3] = ax / Math.max(1, cnt * 0.5); d[i * 3 + 1] = ay / Math.max(1, cnt * 0.5); d[i * 3 + 2] = az / Math.max(1, cnt * 0.5);
      }
    }
  }

  applyContactDelta(from: number, to: number): void {
    const p = this.pos, d = this.delta;
    for (let i = from; i < to; i++) {
      p[i * 3] += d[i * 3]; p[i * 3 + 1] += d[i * 3 + 1]; p[i * 3 + 2] += d[i * 3 + 2];
    }
  }

  /** Collide particles [from, to) with proxies and the ground. Accumulates reaction impulses. */
  collide(from: number, to: number, opt: StepOptions, h: number, active: Int32Array, activeCount: number): void {
    const p = this.pos, pr = this.prev, w = this.invMass, r = this.radius, m = this.mass, fr = this.friction, fl = this.flags;
    const set = opt.proxies, data = set.data, imp = opt.impulses, com = opt.bodyCom;
    const n = this.nScratch;
    const invH = 1 / h;
    const H = this.H;
    for (let i = from; i < to; i++) {
      if (w[i] === 0 || fl[i] & FLAG_GRABBED) continue;
      const ri = r[i];
      const isFluid = (fl[i] & FLAG_FLUID) !== 0;
      const reach = isFluid ? H : ri;
      let wallBest = 1e9;
      let x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      for (let a = 0; a < activeCount; a++) {
        const o = active[a] * PROXY_STRIDE;
        if (x < data[o + 12] - reach || x > data[o + 15] + reach || y < data[o + 13] - reach || y > data[o + 16] + reach || z < data[o + 14] - reach || z > data[o + 17] + reach) continue;
        // world -> local: conj(q) * (x - pos)
        const qx = -data[o + 4], qy = -data[o + 5], qz = -data[o + 6], qw = data[o + 7];
        const vx = x - data[o + 1], vy = y - data[o + 2], vz = z - data[o + 3];
        let tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
        const lx = vx + qw * tx + (qy * tz - qz * ty);
        const ly = vy + qw * ty + (qz * tx - qx * tz);
        const lz = vz + qw * tz + (qx * ty - qy * tx);
        const dist = proxyDistance(set, o, lx, ly, lz, n, reach * 2 + 0.05);
        if (dist >= reach) continue;
        // local normal -> world: q * n
        const Qx = data[o + 4], Qy = data[o + 5], Qz = data[o + 6], Qw = data[o + 7];
        tx = 2 * (Qy * n[2] - Qz * n[1]); ty = 2 * (Qz * n[0] - Qx * n[2]); tz = 2 * (Qx * n[1] - Qy * n[0]);
        const nx = n[0] + Qw * tx + (Qy * tz - Qz * ty);
        const ny = n[1] + Qw * ty + (Qz * tx - Qx * tz);
        const nz = n[2] + Qw * tz + (Qx * ty - Qy * tx);
        if (isFluid && dist < wallBest) {
          wallBest = dist;
          this.wallN[i * 3] = nx; this.wallN[i * 3 + 1] = ny; this.wallN[i * 3 + 2] = nz;
        }
        if (dist >= ri) continue;
        const pen = ri - dist;
        let cx = nx * pen, cy = ny * pen, cz = nz * pen;
        // Friction against the moving surface
        const cmx = data[o + 26], cmy = data[o + 27], cmz = data[o + 28];
        const rx = x - cmx, ry = y - cmy, rz = z - cmz;
        const wx = data[o + 23], wy = data[o + 24], wz = data[o + 25];
        const svx = data[o + 20] + (wy * rz - wz * ry), svy = data[o + 21] + (wz * rx - wx * rz), svz = data[o + 22] + (wx * ry - wy * rx);
        let dx = x + cx - pr[i * 3] - svx * h, dy = y + cy - pr[i * 3 + 1] - svy * h, dz = z + cz - pr[i * 3 + 2] - svz * h;
        const dn = dx * nx + dy * ny + dz * nz;
        dx -= dn * nx; dy -= dn * ny; dz -= dn * nz;
        const tl = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const mu = (fr[i] + data[o + 18]) * 0.5;
        if (tl > 1e-9) {
          const k = tl < mu * pen ? 1 : Math.min((mu * pen) / tl, 1);
          cx -= dx * k; cy -= dy * k; cz -= dz * k;
        }
        // Split the correction between particle and body by inverse mass.
        const wp = w[i], wb = data[o + 31];
        const share = wp / (wp + wb);
        x += cx * share; y += cy * share; z += cz * share;
        const slot = data[o + 19];
        if (slot >= 0 && wb > 0) {
          const s = -invH / (wp + wb);
          const jx = cx * s, jy = cy * s, jz = cz * s;
          const b = slot * 6;
          imp[b] += jx; imp[b + 1] += jy; imp[b + 2] += jz;
          const bx = x - com[slot * 3], by = y - com[slot * 3 + 1], bz = z - com[slot * 3 + 2];
          imp[b + 3] += by * jz - bz * jy; imp[b + 4] += bz * jx - bx * jz; imp[b + 5] += bx * jy - by * jx;
        }
      }
      if (isFluid && opt.ground && y < H && y < wallBest) {
        wallBest = Math.max(0, y);
        this.wallN[i * 3] = 0; this.wallN[i * 3 + 1] = 1; this.wallN[i * 3 + 2] = 0;
      }
      if (isFluid) this.wallD[i] = wallBest;
      if (opt.ground && y < ri) {
        const pen = ri - y;
        y = ri;
        // Ground friction
        let dx = x - pr[i * 3], dz = z - pr[i * 3 + 2];
        const tl = Math.sqrt(dx * dx + dz * dz);
        const mu = (fr[i] + 0.8) * 0.5;
        if (tl > 1e-9) {
          const k = tl < mu * pen ? 1 : Math.min((mu * pen) / tl, 1);
          dx *= k; dz *= k;
          x -= dx; z -= dz;
        }
      }
      p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    }
  }

  finalize(from: number, to: number, h: number, damping: number): void {
    const p = this.pos, pr = this.prev, v = this.vel, f = this.flags;
    const invH = 1 / h;
    const keep = Math.max(0, 1 - damping * h);
    for (let i = from; i < to; i++) {
      const k = i * 3;
      let vx = (p[k] - pr[k]) * invH, vy = (p[k + 1] - pr[k + 1]) * invH, vz = (p[k + 2] - pr[k + 2]) * invH;
      if (!(f[i] & FLAG_FLUID)) { vx *= keep; vy *= keep; vz *= keep; }
      const s2 = vx * vx + vy * vy + vz * vz;
      if (s2 > MAX_SPEED * MAX_SPEED) {
        const s = MAX_SPEED / Math.sqrt(s2);
        vx *= s; vy *= s; vz *= s;
      }
      v[k] = vx; v[k + 1] = vy; v[k + 2] = vz;
    }
  }

  /** XSPH viscosity: blend fluid velocities towards their neighbours'. */
  viscosityKernel(from: number, to: number): void {
    const p = this.pos, v = this.vel, nb = this.neighbors, nc = this.nCount, f = this.flags, d = this.delta, visc = this.viscosity;
    const H2 = this.H * this.H, rho0 = this.rho0;
    for (let i = from; i < to; i++) {
      d[i * 3] = d[i * 3 + 1] = d[i * 3 + 2] = 0;
      if (!(f[i] & FLAG_FLUID) || visc[i] === 0) continue;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      let ax = 0, ay = 0, az = 0;
      const base = i * MAX_NEIGHBORS;
      for (let k = 0; k < nc[i]; k++) {
        const j = nb[base + k];
        if (!(f[j] & FLAG_FLUID)) continue;
        const dx = x - p[j * 3], dy = y - p[j * 3 + 1], dz = z - p[j * 3 + 2];
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 >= H2) continue;
        const t = H2 - r2;
        const wgt = (this.poly6 * t * t * t) / rho0;
        ax += (v[j * 3] - v[i * 3]) * wgt; ay += (v[j * 3 + 1] - v[i * 3 + 1]) * wgt; az += (v[j * 3 + 2] - v[i * 3 + 2]) * wgt;
      }
      const c = visc[i];
      d[i * 3] = ax * c; d[i * 3 + 1] = ay * c; d[i * 3 + 2] = az * c;
    }
  }

  applyViscosity(from: number, to: number): void {
    const v = this.vel, d = this.delta, f = this.flags;
    for (let i = from; i < to; i++) {
      if (!(f[i] & FLAG_FLUID)) continue;
      v[i * 3] += d[i * 3]; v[i * 3 + 1] += d[i * 3 + 1]; v[i * 3 + 2] += d[i * 3 + 2];
    }
  }

  // ------------------------------------------------------------------ per-step helpers

  /** Attachments follow their body (or stay fixed); reaction goes back to the body. */
  solveAttachments(opt: StepOptions, h: number, alpha: number): void {
    const p = this.pos, poses = opt.bodyPoses;
    for (const a of this.attachments) {
      const i = a.particle;
      let tx: number, ty: number, tz: number;
      if (a.slot < 0) {
        [tx, ty, tz] = a.local;
      } else {
        const o = a.slot * 7;
        const qx = poses[o + 3], qy = poses[o + 4], qz = poses[o + 5], qw = poses[o + 6];
        const [lx, ly, lz] = a.local;
        const ux = 2 * (qy * lz - qz * ly), uy = 2 * (qz * lx - qx * lz), uz = 2 * (qx * ly - qy * lx);
        tx = poses[o] + lx + qw * ux + (qy * uz - qz * uy);
        ty = poses[o + 1] + ly + qw * uy + (qz * ux - qx * uz);
        tz = poses[o + 2] + lz + qw * uz + (qx * uy - qy * ux);
      }
      const dx = tx - p[i * 3], dy = ty - p[i * 3 + 1], dz = tz - p[i * 3 + 2];
      p[i * 3] = tx; p[i * 3 + 1] = ty; p[i * 3 + 2] = tz;
      if (a.slot >= 0 && this.mass[i] > 0) {
        // Equal and opposite impulse on the body: the cloth pulls back.
        const s = -(this.mass[i] / h) * alpha;
        const b = a.slot * 6;
        opt.impulses[b] += dx * s; opt.impulses[b + 1] += dy * s; opt.impulses[b + 2] += dz * s;
      }
    }
  }

  applyGrabs(): void {
    for (const g of this.grabs.values()) {
      const i = g.particle;
      this.pos[i * 3] = g.target[0];
      this.pos[i * 3 + 1] = g.target[1];
      this.pos[i * 3 + 2] = g.target[2];
    }
  }

  /** Per-triangle aerodynamic drag/lift for cloth (once per step). */
  clothAerodynamics(dt: number, wind: [number, number, number], airDensity: number): void {
    const p = this.pos, v = this.vel, w = this.invMass;
    for (const c of this.cloths) {
      const t = c.triangles;
      for (let k = 0; k < t.length; k += 3) {
        const a = t[k], b = t[k + 1], cc = t[k + 2];
        const e1x = p[b * 3] - p[a * 3], e1y = p[b * 3 + 1] - p[a * 3 + 1], e1z = p[b * 3 + 2] - p[a * 3 + 2];
        const e2x = p[cc * 3] - p[a * 3], e2y = p[cc * 3 + 1] - p[a * 3 + 1], e2z = p[cc * 3 + 2] - p[a * 3 + 2];
        let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const n2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (n2 < 1e-12) continue;
        const area = n2 * 0.5;
        nx /= n2; ny /= n2; nz /= n2;
        const rvx = wind[0] - (v[a * 3] + v[b * 3] + v[cc * 3]) / 3;
        const rvy = wind[1] - (v[a * 3 + 1] + v[b * 3 + 1] + v[cc * 3 + 1]) / 3;
        const rvz = wind[2] - (v[a * 3 + 2] + v[b * 3 + 2] + v[cc * 3 + 2]) / 3;
        const vn = rvx * nx + rvy * ny + rvz * nz;
        // Pressure drag on the normal component (C_d ≈ 1.2) plus a little skin friction
        const fN = 0.5 * airDensity * 1.2 * area * vn * Math.abs(vn);
        const fx = nx * fN + rvx * area * 0.02, fy = ny * fN + rvy * area * 0.02, fz = nz * fN + rvz * area * 0.02;
        for (const q of [a, b, cc]) {
          const s = (w[q] * dt) / 3;
          v[q * 3] += fx * s; v[q * 3 + 1] += fy * s; v[q * 3 + 2] += fz * s;
        }
      }
    }
  }

  runEmitters(dt: number, maxParticles: number, makeParticle: (e: Emitter, i: number) => void): void {
    for (const e of this.emitters) {
      if (e.remaining <= 0) continue;
      e.acc += e.rate * dt;
      let n = Math.min(Math.floor(e.acc), e.remaining, Math.max(0, maxParticles - this.count));
      if (n <= 0) continue;
      e.acc -= n;
      e.remaining -= n;
      this.addParticles(n, (_k, i) => {
        // Uniform disc perpendicular to the jet direction
        const [vx, vy, vz] = e.velocity;
        const vl = Math.hypot(vx, vy, vz) || 1;
        const dx = vx / vl, dy = vy / vl, dz = vz / vl;
        const ux = Math.abs(dy) < 0.9 ? 0 : 1, uy = Math.abs(dy) < 0.9 ? 1 : 0;
        let ax = uy * dz - 0 * dy, ay = 0 * dx - ux * dz, az = ux * dy - uy * dx;
        const al = Math.hypot(ax, ay, az) || 1;
        ax /= al; ay /= al; az /= al;
        const bx = dy * az - dz * ay, by = dz * ax - dx * az, bz = dx * ay - dy * ax;
        const ang = this.random() * Math.PI * 2, rad = Math.sqrt(this.random()) * e.radius;
        const ca = Math.cos(ang) * rad, sa = Math.sin(ang) * rad;
        const jitter = this.random() * vl * dt;
        this.pos[i * 3] = e.position[0] + ax * ca + bx * sa + dx * jitter;
        this.pos[i * 3 + 1] = e.position[1] + ay * ca + by * sa + dy * jitter;
        this.pos[i * 3 + 2] = e.position[2] + az * ca + bz * sa + dz * jitter;
        this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
        makeParticle(e, i);
      });
      n = 0;
    }
  }

  /** Proxies that overlap the particle cloud (broadphase). */
  activeProxies(set: ProxySet, out: Int32Array): number {
    if (this.count === 0) return 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const p = this.pos;
    for (let i = 0; i < this.count; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const m = 0.5;
    let n = 0;
    const d = set.data;
    for (let k = 0; k < set.count && n < out.length; k++) {
      const o = k * PROXY_STRIDE;
      if (d[o + 15] < minX - m || d[o + 12] > maxX + m || d[o + 16] < minY - m || d[o + 13] > maxY + m || d[o + 17] < minZ - m || d[o + 14] > maxZ + m) continue;
      out[n++] = k;
    }
    return n;
  }

  private activeBuf = new Int32Array(1024);
  private volumeLambdas: { v: number }[] = [];

  /** One full step (dt) on the calling thread. */
  step(opt: StepOptions): void {
    if (this.count === 0) return;
    const n = this.count;
    const S = Math.max(1, opt.substeps);
    const h = opt.dt / S;
    const [gx, gy, gz] = opt.gravity;
    if (this.activeBuf.length < opt.proxies.count) this.activeBuf = new Int32Array(opt.proxies.count * 2);
    const activeCount = this.activeProxies(opt.proxies, this.activeBuf);

    if (this.cloths.length && (opt.wind[0] || opt.wind[1] || opt.wind[2] || opt.airDensity > 0)) this.clothAerodynamics(opt.dt, opt.wind, opt.airDensity);
    this.buildNeighbors();

    for (let s = 0; s < S; s++) {
      this.predict(0, n, h, gx, gy, gz);
      this.applyGrabs();
      this.solveAttachments(opt, h, 1);
      this.cLambda.fill(0, 0, this.cCount);
      this.solveDistance(0, this.cCount, h);
      while (this.volumeLambdas.length < this.softBodies.length) this.volumeLambdas.push({ v: 0 });
      for (let k = 0; k < this.softBodies.length; k++) {
        const sb = this.softBodies[k];
        this.volumeLambdas[k].v = 0;
        this.solveVolume(sb, h, this.volumeLambdas[k]);
        this.solveShapeMatching(sb, sb.shapeMatching);
      }
      if (this.fluidCount > 0) {
        for (let it = 0; it < opt.fluidIterations; it++) {
          this.fluidLambda(0, n);
          this.fluidDelta(0, n);
          this.applyFluidDelta(0, n);
        }
      }
      this.contacts(0, n);
      this.applyContactDelta(0, n);
      this.collide(0, n, opt, h, this.activeBuf, activeCount);
      this.applyGrabs();
      this.finalize(0, n, h, 0.4);
      if (this.fluidCount > 0) {
        this.viscosityKernel(0, n);
        this.applyViscosity(0, n);
      }
    }
  }
}
