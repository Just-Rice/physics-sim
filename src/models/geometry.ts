import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';
import type { ShapeDef } from './schema';

const geoCache = new Map<string, THREE.BufferGeometry>();

/** Corner radius used for boxes; the physics collider uses the same rounding. */
export function boxRounding(size: [number, number, number]): number {
  const m = Math.min(size[0], size[1], size[2]);
  return Math.min(0.015, m * 0.08);
}

export function capsuleMiddle(radius: number, height: number): number {
  return Math.max(0, height - 2 * radius);
}

export function primitiveGeometry(shape: Exclude<ShapeDef, { type: 'mesh' }>): THREE.BufferGeometry {
  let key: string;
  switch (shape.type) {
    case 'box': key = `box:${shape.size.join(',')}`; break;
    case 'sphere': key = `sphere:${shape.radius}`; break;
    case 'cylinder': key = `cyl:${shape.radius},${shape.height}`; break;
    case 'capsule': key = `cap:${shape.radius},${shape.height}`; break;
    case 'cone': key = `cone:${shape.radius},${shape.height}`; break;
  }
  const cached = geoCache.get(key);
  if (cached) return cached;
  let g: THREE.BufferGeometry;
  switch (shape.type) {
    case 'box': {
      const r = boxRounding(shape.size);
      g = r > 0.001 ? new RoundedBoxGeometry(shape.size[0], shape.size[1], shape.size[2], 2, r) : new THREE.BoxGeometry(...shape.size);
      break;
    }
    case 'sphere': {
      const seg = shape.radius > 1 ? 96 : 48;
      g = new THREE.SphereGeometry(shape.radius, seg, Math.round(seg * 0.66));
      break;
    }
    case 'cylinder':
      g = new THREE.CylinderGeometry(shape.radius, shape.radius, shape.height, 48, 1);
      break;
    case 'capsule':
      g = new THREE.CapsuleGeometry(shape.radius, capsuleMiddle(shape.radius, shape.height), 10, 32);
      break;
    case 'cone':
      g = new THREE.ConeGeometry(shape.radius, shape.height, 48, 1);
      break;
  }
  geoCache.set(key, g);
  return g;
}

export interface HullData {
  /** Plane list: nx, ny, nz, d with n·p + d = signed distance (outward). */
  planes: Float32Array;
  vertices: Float32Array;
  radius: number;
  centroid: THREE.Vector3;
}

/** Convex hull (planes + vertices) of a point cloud, used for particle collisions. */
export function computeHull(points: Float32Array, maxPoints = 4000): HullData {
  const stride = Math.max(1, Math.floor(points.length / 3 / maxPoints));
  const vecs: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i += 3 * stride) vecs.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
  const hull = new ConvexHull().setFromPoints(vecs);
  const planes: number[] = [];
  const verts: number[] = [];
  const centroid = new THREE.Vector3();
  for (const v of hull.vertices) {
    verts.push(v.point.x, v.point.y, v.point.z);
    centroid.add(v.point);
  }
  centroid.divideScalar(Math.max(1, hull.vertices.length));
  for (const f of hull.faces) {
    // ConvexHull face plane: normal · p = constant
    planes.push(f.normal.x, f.normal.y, f.normal.z, -f.constant);
  }
  let radius = 0;
  for (let i = 0; i < verts.length; i += 3) radius = Math.max(radius, Math.hypot(verts[i], verts[i + 1], verts[i + 2]));
  return { planes: new Float32Array(planes), vertices: new Float32Array(verts), radius, centroid };
}

/** Collect world-ish positions of all meshes under `root`, expressed in root's local space. */
export function collectPoints(root: THREE.Object3D, scale: THREE.Vector3 = new THREE.Vector3(1, 1, 1)): Float32Array {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const s = new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z);
  const out: number[] = [];
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    m.multiplyMatrices(inv, mesh.matrixWorld).premultiply(s);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      out.push(v.x, v.y, v.z);
    }
  });
  return new Float32Array(out);
}

/** Merge all meshes under `root` into one indexed triangle soup in root space (for trimesh colliders). */
export function collectTrimesh(root: THREE.Object3D, scale: THREE.Vector3 = new THREE.Vector3(1, 1, 1)): { vertices: Float32Array; indices: Uint32Array } {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const s = new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z);
  const verts: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    m.multiplyMatrices(inv, mesh.matrixWorld).premultiply(s);
    const base = verts.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      verts.push(v.x, v.y, v.z);
    }
    const index = mesh.geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
    else for (let i = 0; i < pos.count; i++) idx.push(base + i);
  });
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
}

export function triangleCount(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const index = mesh.geometry.getIndex();
    n += (index ? index.count : mesh.geometry.getAttribute('position')?.count ?? 0) / 3;
  });
  return Math.round(n);
}

export const DEG = Math.PI / 180;

export function eulerDeg(r: [number, number, number]): THREE.Euler {
  return new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ');
}

export function quatFromDeg(r: [number, number, number]): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(eulerDeg(r));
}

export function degFromQuat(q: THREE.Quaternion): [number, number, number] {
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  const r = (x: number) => Math.round((x / DEG) * 1000) / 1000;
  return [r(e.x), r(e.y), r(e.z)];
}
