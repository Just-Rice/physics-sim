import * as THREE from 'three';
import { TeapotGeometry } from 'three/addons/geometries/TeapotGeometry.js';
import { computeHull, collectPoints, collectTrimesh, type HullData } from './geometry';

/**
 * Mesh assets referenced by `mesh` shapes. Procedural assets ("proc:*") are
 * built in code; imported assets are GLB files stored in IndexedDB and parsed
 * into a template Object3D when the library loads.
 */
export interface MeshAsset {
  id: string;
  name: string;
  root: THREE.Object3D;
  source: 'proc' | 'import';
  /** Original file bytes for imported assets (kept for export / persistence). */
  bytes?: ArrayBuffer;
}

const assets = new Map<string, MeshAsset>();
const hullCache = new Map<string, HullData>();
const trimeshCache = new Map<string, { vertices: Float32Array; indices: Uint32Array }>();

export function registerAsset(asset: MeshAsset): void {
  assets.set(asset.id, asset);
  for (const k of [...hullCache.keys()]) if (k.startsWith(asset.id + '|')) hullCache.delete(k);
  for (const k of [...trimeshCache.keys()]) if (k.startsWith(asset.id + '|')) trimeshCache.delete(k);
  listeners.forEach((l) => l(asset.id));
}

const listeners = new Set<(id: string) => void>();
/** Notified when an asset is (re)registered, e.g. a hot-reloaded Blender export. */
export function onAssetChanged(fn: (id: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function hasAsset(id: string): boolean {
  return assets.has(id);
}

export function getAsset(id: string): MeshAsset | undefined {
  return assets.get(id);
}

export function allAssets(): MeshAsset[] {
  return [...assets.values()];
}

function findNode(root: THREE.Object3D, node?: string): THREE.Object3D | undefined {
  if (!node) return root;
  return root.getObjectByName(node);
}

/** Clone of an asset (or one node of it) with the node's own transform reset to identity. */
export function cloneAssetNode(id: string, node?: string): THREE.Object3D | null {
  const a = assets.get(id);
  if (!a) return null;
  const src = findNode(a.root, node);
  if (!src) return null;
  const clone = src.clone(true);
  clone.position.set(0, 0, 0);
  clone.quaternion.identity();
  clone.scale.set(1, 1, 1);
  clone.visible = true;
  clone.traverse((o) => {
    o.visible = o.userData.__collider ? false : o.visible;
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  return clone;
}

function nodeRoot(id: string, node?: string): THREE.Object3D | null {
  const a = assets.get(id);
  if (!a) return null;
  const src = findNode(a.root, node);
  if (!src) return null;
  // Evaluate geometry in the node's own frame.
  const holder = src.clone(true);
  holder.position.set(0, 0, 0);
  holder.quaternion.identity();
  holder.scale.set(1, 1, 1);
  holder.updateMatrixWorld(true);
  return holder;
}

export function assetHull(id: string, node: string | undefined, scale: THREE.Vector3): HullData | null {
  const key = `${id}|${node ?? ''}|${scale.toArray().join(',')}`;
  const c = hullCache.get(key);
  if (c) return c;
  const root = nodeRoot(id, node);
  if (!root) return null;
  const pts = collectPoints(root, scale);
  if (pts.length < 12) return null;
  const hull = computeHull(pts);
  hullCache.set(key, hull);
  return hull;
}

export function assetTrimesh(id: string, node: string | undefined, scale: THREE.Vector3): { vertices: Float32Array; indices: Uint32Array } | null {
  const key = `${id}|${node ?? ''}|${scale.toArray().join(',')}`;
  const c = trimeshCache.get(key);
  if (c) return c;
  const root = nodeRoot(id, node);
  if (!root) return null;
  const t = collectTrimesh(root, scale);
  trimeshCache.set(key, t);
  return t;
}

export function assetBounds(id: string, node: string | undefined, scale: THREE.Vector3): THREE.Box3 | null {
  const root = nodeRoot(id, node);
  if (!root) return null;
  root.scale.copy(scale);
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(root);
}

// ---------------------------------------------------------------------------
// Procedural assets

/** Seamless photo-studio backdrop: floor that curves up into a back wall. */
function cycloramaGeometry(width = 60, depth = 30, radius = 2, height = 14): THREE.BufferGeometry {
  const profile: [number, number][] = []; // (z, y)
  profile.push([depth, 0]);
  profile.push([0, 0]);
  const arc = 16;
  for (let i = 1; i <= arc; i++) {
    const a = (i / arc) * (Math.PI / 2);
    profile.push([-Math.sin(a) * radius, radius - Math.cos(a) * radius]);
  }
  profile.push([-radius, height]);
  const cols = 2;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < profile.length; i++) {
    for (let j = 0; j <= cols; j++) {
      const x = (j / cols - 0.5) * width;
      pos.push(x, profile[i][1], profile[i][0]);
    }
  }
  for (let i = 0; i < profile.length - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j, b = a + 1, c = a + cols + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function procMesh(geometry: THREE.BufferGeometry, name: string): THREE.Object3D {
  const g = new THREE.Group();
  g.name = name;
  const m = new THREE.Mesh(geometry, new THREE.MeshPhysicalMaterial({ color: '#cccccc' }));
  m.name = name + '_mesh';
  g.add(m);
  return g;
}

export function registerProceduralAssets(): void {
  const teapot = new TeapotGeometry(0.25, 10, true, true, true, true, true);
  teapot.computeVertexNormals();
  registerAsset({ id: 'proc:teapot', name: 'Teapot', root: procMesh(teapot, 'Teapot'), source: 'proc' });

  const knot = new THREE.TorusKnotGeometry(0.3, 0.1, 160, 24);
  registerAsset({ id: 'proc:torusknot', name: 'Torus knot', root: procMesh(knot, 'TorusKnot'), source: 'proc' });

  const gem = new THREE.IcosahedronGeometry(0.25, 0);
  gem.computeVertexNormals();
  registerAsset({ id: 'proc:gem', name: 'Gem', root: procMesh(gem, 'Gem'), source: 'proc' });

  const bowlPts: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = (i / 24) * Math.PI * 0.5;
    bowlPts.push(new THREE.Vector2(Math.sin(t) * 0.5, -Math.cos(t) * 0.35 + 0.35));
  }
  for (let i = 24; i >= 0; i--) {
    const t = (i / 24) * Math.PI * 0.5;
    bowlPts.push(new THREE.Vector2(Math.sin(t) * 0.46, -Math.cos(t) * 0.31 + 0.35));
  }
  const bowl = new THREE.LatheGeometry(bowlPts, 64);
  bowl.computeVertexNormals();
  registerAsset({ id: 'proc:bowl', name: 'Bowl', root: procMesh(bowl, 'Bowl'), source: 'proc' });

  // A bowling pin profile
  const pin: THREE.Vector2[] = [
    [0, 0], [0.026, 0], [0.04, 0.03], [0.058, 0.09], [0.06, 0.12], [0.052, 0.17], [0.034, 0.22], [0.024, 0.26],
    [0.026, 0.29], [0.033, 0.32], [0.034, 0.345], [0.026, 0.37], [0.012, 0.38], [0, 0.381],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const pinGeo = new THREE.LatheGeometry(pin, 40);
  pinGeo.translate(0, -0.19, 0);
  pinGeo.computeVertexNormals();
  registerAsset({ id: 'proc:pin', name: 'Bowling pin', root: procMesh(pinGeo, 'Pin'), source: 'proc' });

  registerAsset({ id: 'proc:cyclorama', name: 'Studio backdrop', root: procMesh(cycloramaGeometry(), 'Cyclorama'), source: 'proc' });

  const ring = new THREE.TorusGeometry(0.3, 0.08, 24, 64);
  registerAsset({ id: 'proc:torus', name: 'Torus', root: procMesh(ring, 'Torus'), source: 'proc' });
}
