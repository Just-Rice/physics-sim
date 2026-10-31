import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLAG_CLOTH, FLAG_FLUID, FLAG_SOFT, FLUID_PHASE, type ParticleWorld } from './ParticleWorld';
import type { SoftPartDef } from '../../models/schema';
import { quatFromDeg } from '../../models/geometry';
import { cloneAssetNode } from '../../models/assets';

/** Indexed triangle mesh with shared vertices (welded by position). */
export interface TopoMesh {
  positions: Float32Array;
  uvs: Float32Array | null;
  index: Uint32Array;
}

export function weld(geo: THREE.BufferGeometry): TopoMesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geo.getAttribute('position').clone());
  const uv = geo.getAttribute('uv');
  if (uv) g.setAttribute('uv', uv.clone());
  if (geo.index) g.setIndex(geo.index.clone());
  // Weld on position only so UV seams don't split the physics mesh.
  const posOnly = new THREE.BufferGeometry();
  posOnly.setAttribute('position', g.getAttribute('position'));
  if (g.index) posOnly.setIndex(g.index);
  const merged = mergeVertices(posOnly, 1e-5);
  const positions = new Float32Array(merged.getAttribute('position').array as ArrayLike<number>);
  const index = new Uint32Array(merged.index ? (merged.index.array as ArrayLike<number>) : Array.from({ length: positions.length / 3 }, (_, i) => i));
  // Carry UVs over by matching welded vertices back to the first source vertex.
  let uvs: Float32Array | null = null;
  if (uv) {
    uvs = new Float32Array((positions.length / 3) * 2);
    const src = g.getAttribute('position');
    const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    const lookup = new Map<string, number>();
    for (let i = 0; i < src.count; i++) {
      const k = key(src.getX(i), src.getY(i), src.getZ(i));
      if (!lookup.has(k)) lookup.set(k, i);
    }
    for (let i = 0; i < positions.length / 3; i++) {
      const s = lookup.get(key(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
      if (s !== undefined) {
        uvs[i * 2] = uv.getX(s);
        uvs[i * 2 + 1] = uv.getY(s);
      }
    }
  }
  return { positions, uvs, index };
}

/** Unique edges plus "bending" pairs (opposite vertices of triangles sharing an edge). */
export function edgesAndBends(index: Uint32Array): { edges: [number, number][]; bends: [number, number][] } {
  const edgeMap = new Map<string, { a: number; b: number; opp: number[] }>();
  for (let t = 0; t < index.length; t += 3) {
    const v = [index[t], index[t + 1], index[t + 2]];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3], o = v[(e + 2) % 3];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      const rec = edgeMap.get(k);
      if (rec) rec.opp.push(o);
      else edgeMap.set(k, { a: Math.min(a, b), b: Math.max(a, b), opp: [o] });
    }
  }
  const edges: [number, number][] = [];
  const bends: [number, number][] = [];
  const bendSet = new Set<string>();
  for (const r of edgeMap.values()) {
    edges.push([r.a, r.b]);
    if (r.opp.length === 2) {
      const [x, y] = r.opp;
      const k = x < y ? `${x}_${y}` : `${y}_${x}`;
      if (!bendSet.has(k)) {
        bendSet.add(k);
        bends.push([x, y]);
      }
    }
  }
  return { edges, bends };
}

function meshFromAsset(asset: string, node?: string): THREE.BufferGeometry | null {
  const obj = cloneAssetNode(asset, node);
  if (!obj) return null;
  obj.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'uv') g.deleteAttribute(k);
    parts.push(g.index ? g : g);
  });
  if (!parts.length) return null;
  return parts[0];
}

function surfaceArea(pos: Float32Array, index: Uint32Array): number {
  let a = 0;
  const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
  for (let t = 0; t < index.length; t += 3) {
    v0.fromArray(pos, index[t] * 3);
    v1.fromArray(pos, index[t + 1] * 3).sub(v0);
    v2.fromArray(pos, index[t + 2] * 3).sub(v0);
    a += v1.cross(v2).length() * 0.5;
  }
  return a;
}

function meanEdge(pos: Float32Array, edges: [number, number][]): number {
  let s = 0;
  for (const [a, b] of edges) s += Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  return edges.length ? s / edges.length : 0.05;
}

export interface BuiltSoft {
  start: number;
  count: number;
  /** Triangles in local (0-based) vertex indices for the render mesh. */
  index: Uint32Array;
  uvs: Float32Array | null;
  /** Particles to pin, in local indices, with their world position. */
  pins: number[];
}

export interface Transform {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

function pinsFor(def: Extract<SoftPartDef, { type: 'cloth' }>, local: Float32Array, spacing: number, worldPins: THREE.Vector3[], world: Float32Array): number[] {
  const n = local.length / 3;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, local[i * 3]); maxX = Math.max(maxX, local[i * 3]);
    minY = Math.min(minY, local[i * 3 + 1]); maxY = Math.max(maxY, local[i * 3 + 1]);
  }
  const tol = spacing * 0.45;
  const out = new Set<number>();
  for (let i = 0; i < n; i++) {
    const x = local[i * 3], y = local[i * 3 + 1];
    const top = y > maxY - tol, bottom = y < minY + tol, left = x < minX + tol, right = x > maxX - tol;
    switch (def.pins) {
      case 'top-edge': if (top) out.add(i); break;
      case 'left-edge': if (left) out.add(i); break;
      case 'top-corners': if (top && (left || right)) out.add(i); break;
      case 'corners': if ((top || bottom) && (left || right)) out.add(i); break;
      case 'all-edges': if (top || bottom || left || right) out.add(i); break;
    }
  }
  for (const wp of worldPins) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (world[i * 3] - wp.x) ** 2 + (world[i * 3 + 1] - wp.y) ** 2 + (world[i * 3 + 2] - wp.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) out.add(best);
  }
  return [...out];
}

export function buildCloth(world: ParticleWorld, def: Extract<SoftPartDef, { type: 'cloth' }>, T: Transform, owner: number, maxParticles: number): BuiltSoft | null {
  let geo: THREE.BufferGeometry | null = null;
  if (def.asset) geo = meshFromAsset(def.asset, def.node);
  if (!geo) geo = new THREE.PlaneGeometry(def.size[0], def.size[1], def.resolution[0] - 1, def.resolution[1] - 1);
  const topo = weld(geo);
  const n = topo.positions.length / 3;
  if (world.count + n > maxParticles) return null;
  const { edges, bends } = edgesAndBends(topo.index);
  const spacing = meanEdge(topo.positions, edges);
  const area = surfaceArea(topo.positions, topo.index);
  const m = Math.max(1e-4, (area * def.areaDensity) / n);
  const radius = THREE.MathUtils.clamp(spacing * 0.45, 0.008, 0.05);
  const q = T.quat.clone().multiply(quatFromDeg(def.rotation));
  const origin = new THREE.Vector3(...def.position).applyQuaternion(T.quat).add(T.pos);
  const worldPos = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromArray(topo.positions, i * 3).applyQuaternion(q).add(origin);
    v.toArray(worldPos, i * 3);
  }
  const pinWorld = def.pinnedPoints.map((p) => new THREE.Vector3(...p).applyQuaternion(T.quat).add(T.pos));
  const pins = pinsFor(def, topo.positions, spacing, pinWorld, worldPos);
  const phase = owner;
  const start = world.addParticles(n, (k, i) => {
    world.pos[i * 3] = worldPos[k * 3];
    world.pos[i * 3 + 1] = worldPos[k * 3 + 1];
    world.pos[i * 3 + 2] = worldPos[k * 3 + 2];
    world.mass[i] = m;
    world.invMass[i] = 1 / m;
    world.radius[i] = radius;
    world.phase[i] = phase;
    world.flags[i] = FLAG_CLOTH;
    world.friction[i] = 0.6;
    world.owner[i] = owner;
  });
  const cStart = world.cCount;
  const stretch = Math.max(def.stretch, 1e-9);
  for (const [a, b] of edges) world.addDistance(start + a, start + b, stretch);
  for (const [a, b] of bends) world.addDistance(start + a, start + b, Math.max(def.bend, 1e-7));
  const triangles = new Int32Array(topo.index.length);
  for (let k = 0; k < triangles.length; k++) triangles[k] = start + topo.index[k];
  world.cloths.push({ start, count: n, triangles, cStart, cCount: world.cCount - cStart });
  world.ranges.push({ start, count: n, cStart, cCount: world.cCount - cStart });
  return { start, count: n, index: topo.index, uvs: topo.uvs, pins };
}

function softGeometry(def: Extract<SoftPartDef, { type: 'softbody' }>): THREE.BufferGeometry | null {
  const [sx, sy, sz] = def.size;
  switch (def.shape) {
    case 'box': {
      const seg = Math.max(2, def.detail * 2);
      return new THREE.BoxGeometry(sx, sy, sz, seg, seg, seg);
    }
    case 'torus':
      return new THREE.TorusGeometry(sx, sy, 6 + def.detail * 4, 12 + def.detail * 8);
    case 'mesh':
      return def.asset ? meshFromAsset(def.asset, def.node) : null;
    default:
      return new THREE.IcosahedronGeometry(1, Math.max(1, def.detail + 1)).scale(sx, sy, sz);
  }
}

export function buildSoftBody(world: ParticleWorld, def: Extract<SoftPartDef, { type: 'softbody' }>, T: Transform, owner: number, maxParticles: number): BuiltSoft | null {
  const geo = softGeometry(def);
  if (!geo) return null;
  const topo = weld(geo);
  const n = topo.positions.length / 3;
  if (world.count + n > maxParticles) return null;
  const { edges } = edgesAndBends(topo.index);
  const spacing = meanEdge(topo.positions, edges);
  const radius = THREE.MathUtils.clamp(spacing * 0.5, 0.01, 0.06);
  const m = def.mass / n;
  const q = T.quat.clone().multiply(quatFromDeg(def.rotation));
  const origin = new THREE.Vector3(...def.position).applyQuaternion(T.quat).add(T.pos);
  const v = new THREE.Vector3();
  const start = world.addParticles(n, (k, i) => {
    v.fromArray(topo.positions, k * 3).applyQuaternion(q).add(origin);
    world.pos[i * 3] = v.x; world.pos[i * 3 + 1] = v.y; world.pos[i * 3 + 2] = v.z;
    world.mass[i] = m;
    world.invMass[i] = 1 / m;
    world.radius[i] = radius;
    world.phase[i] = owner;
    world.flags[i] = FLAG_SOFT;
    world.friction[i] = 0.7;
    world.owner[i] = owner;
  });
  const cStart = world.cCount;
  for (const [a, b] of edges) world.addDistance(start + a, start + b, def.compliance);
  // Rest volume and shape-matching offsets in world orientation at spawn
  const triangles = new Int32Array(topo.index.length);
  for (let k = 0; k < triangles.length; k++) triangles[k] = start + topo.index[k];
  let vol = 0;
  const p = world.pos;
  for (let k = 0; k < triangles.length; k += 3) {
    const a = triangles[k] * 3, b = triangles[k + 1] * 3, c = triangles[k + 2] * 3;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += p[(start + i) * 3]; cy += p[(start + i) * 3 + 1]; cz += p[(start + i) * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  const rest = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rest[i * 3] = p[(start + i) * 3] - cx;
    rest[i * 3 + 1] = p[(start + i) * 3 + 1] - cy;
    rest[i * 3 + 2] = p[(start + i) * 3 + 2] - cz;
  }
  world.softBodies.push({
    start, count: n, triangles,
    restVolume: Math.abs(vol), pressure: def.pressure, volumeCompliance: 0,
    shapeMatching: def.shapeMatching, restOffsets: rest, rot: new Float64Array([0, 0, 0, 1]), grads: new Float32Array(n * 3),
  });
  world.ranges.push({ start, count: n, cStart, cCount: world.cCount - cStart });
  // Fix winding if the source mesh was inside-out
  if (vol < 0) {
    const sb = world.softBodies[world.softBodies.length - 1];
    for (let k = 0; k < sb.triangles.length; k += 3) {
      const t = sb.triangles[k + 1];
      sb.triangles[k + 1] = sb.triangles[k + 2];
      sb.triangles[k + 2] = t;
    }
  }
  return { start, count: n, index: topo.index, uvs: topo.uvs, pins: [] };
}

export function fillFluid(world: ParticleWorld, def: Extract<SoftPartDef, { type: 'fluid' }>, T: Transform, owner: number, maxParticles: number): number {
  const r = world.fluidRadius;
  const d = 2 * r;
  const [sx, sy, sz] = def.size;
  const nx = Math.max(1, Math.floor(sx / d)), ny = Math.max(1, Math.floor(sy / d)), nz = Math.max(1, Math.floor(sz / d));
  let total = nx * ny * nz;
  const budget = Math.max(0, maxParticles - world.count);
  if (total > budget) total = budget;
  if (total <= 0) return 0;
  const centre = new THREE.Vector3(...def.position).applyQuaternion(T.quat).add(T.pos);
  const m = 1000 * d * d * d;
  let k = 0;
  const pts: number[] = [];
  // Small deterministic jitter breaks the perfect lattice without making runs irreproducible.
  let seed = (owner * 2654435761) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let y = 0; y < ny && k < total; y++) for (let x = 0; x < nx && k < total; x++) for (let z = 0; z < nz && k < total; z++, k++) {
    pts.push(
      centre.x + (x - (nx - 1) / 2) * d + (rand() - 0.5) * d * 0.02,
      centre.y + (y - (ny - 1) / 2) * d,
      centre.z + (z - (nz - 1) / 2) * d + (rand() - 0.5) * d * 0.02,
    );
  }
  world.addParticles(total, (j, i) => initFluidParticle(world, i, pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2], m, def.viscosity, owner));
  return total;
}

export function initFluidParticle(world: ParticleWorld, i: number, x: number, y: number, z: number, m: number, viscosity: number, owner: number): void {
  world.pos[i * 3] = x; world.pos[i * 3 + 1] = y; world.pos[i * 3 + 2] = z;
  world.mass[i] = m;
  world.invMass[i] = 1 / m;
  world.radius[i] = world.fluidRadius;
  world.phase[i] = FLUID_PHASE;
  world.flags[i] = FLAG_FLUID;
  world.friction[i] = 0.02;
  world.viscosity[i] = viscosity;
  world.owner[i] = owner;
}

export function addEmitter(world: ParticleWorld, def: Extract<SoftPartDef, { type: 'fluid' }>, T: Transform, owner: number): void {
  const e = def.emitter!;
  const pos = new THREE.Vector3(...def.position).applyQuaternion(T.quat).add(T.pos);
  const vel = new THREE.Vector3(...e.velocity).applyQuaternion(T.quat);
  world.emitters.push({ owner, position: [pos.x, pos.y, pos.z], velocity: [vel.x, vel.y, vel.z], radius: e.radius, rate: e.rate, remaining: e.total, viscosity: def.viscosity, acc: 0 });
}

export { FLAG_FLUID };
