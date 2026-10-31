import * as THREE from 'three';
import type { ModelDef, ShapeDef } from './schema';
import { primitiveGeometry, quatFromDeg } from './geometry';
import { assetBounds } from './assets';

const cache = new WeakMap<ModelDef, THREE.Box3>();

function shapeBox(shape: ShapeDef): THREE.Box3 {
  if (shape.type === 'mesh') {
    return assetBounds(shape.asset, shape.node, new THREE.Vector3(...shape.scale)) ?? new THREE.Box3(new THREE.Vector3(-0.25, -0.25, -0.25), new THREE.Vector3(0.25, 0.25, 0.25));
  }
  const g = primitiveGeometry(shape);
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox!.clone();
}

/** Axis-aligned bounds of a model in its own (unplaced) frame. */
export function modelBounds(model: ModelDef): THREE.Box3 {
  const c = cache.get(model);
  if (c) return c.clone();
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  const ms = new THREE.Matrix4();
  for (const part of model.parts) {
    const pm = new THREE.Matrix4().compose(new THREE.Vector3(...part.position), quatFromDeg(part.rotation), new THREE.Vector3(1, 1, 1));
    for (const s of part.shapes) {
      ms.compose(new THREE.Vector3(...s.position), quatFromDeg(s.rotation), new THREE.Vector3(1, 1, 1));
      m.multiplyMatrices(pm, ms);
      box.union(shapeBox(s).applyMatrix4(m));
    }
  }
  for (const sp of model.softParts) {
    const p = new THREE.Vector3(...sp.position);
    let half: THREE.Vector3;
    if (sp.type === 'cloth') {
      half = new THREE.Vector3(sp.size[0] / 2, sp.size[1] / 2, 0.02);
      const q = quatFromDeg(sp.rotation);
      const b = new THREE.Box3(half.clone().negate(), half).applyMatrix4(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)));
      box.union(b);
      continue;
    } else if (sp.type === 'softbody') {
      half = new THREE.Vector3(...sp.size);
      if (sp.shape === 'box') half.multiplyScalar(0.5);
      if (sp.shape === 'torus') half.set(sp.size[0] + sp.size[1], sp.size[1], sp.size[0] + sp.size[1]);
    } else {
      half = new THREE.Vector3(...sp.size).multiplyScalar(0.5);
    }
    box.union(new THREE.Box3(p.clone().sub(half), p.clone().add(half)));
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.25, -0.25, -0.25), new THREE.Vector3(0.25, 0.25, 0.25));
  cache.set(model, box.clone());
  return box;
}
