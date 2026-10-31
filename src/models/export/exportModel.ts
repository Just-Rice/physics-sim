import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { ModelDef, ShapeDef } from '../schema';
import { makeThreeMaterial, resolveMaterial } from '../materials';
import { primitiveGeometry, quatFromDeg } from '../geometry';
import { cloneAssetNode } from '../assets';

/**
 * GLB export that keeps physics data in glTF "extras" (Blender shows these as
 * Custom Properties). The importer reads the same keys, so a model can go
 * Physics Sim → Blender → Physics Sim without losing joints or materials.
 */

function shapeObject(shape: ShapeDef, name: string, materialRef: unknown): THREE.Object3D {
  const spec = resolveMaterial((shape.material ?? materialRef) as never);
  let obj: THREE.Object3D;
  if (shape.type === 'mesh') {
    obj = cloneAssetNode(shape.asset, shape.node) ?? new THREE.Group();
    obj.scale.set(...shape.scale);
  } else {
    obj = new THREE.Mesh(primitiveGeometry(shape).clone(), makeThreeMaterial(spec).clone());
  }
  obj.name = shape.visible ? name : `COL_${name}`;
  obj.position.set(...shape.position);
  obj.quaternion.copy(quatFromDeg(shape.rotation));
  obj.userData = {
    ps_shape: JSON.stringify(shape),
    ...(shape.type === 'mesh' ? { ps_collider: shape.collider } : {}),
    ...(shape.collide ? {} : { ps_collide: false }),
  };
  return obj;
}

export function buildExportScene(model: ModelDef): THREE.Group {
  const root = new THREE.Group();
  root.name = model.name;
  root.userData = { ps_model: JSON.stringify({ id: model.id, name: model.name, category: model.category, description: model.description }) };
  for (const part of model.parts) {
    const g = new THREE.Group();
    g.name = part.id;
    g.position.set(...part.position);
    g.quaternion.copy(quatFromDeg(part.rotation));
    g.userData = {
      ps_part: JSON.stringify({ ...part, shapes: undefined }),
      ps_body: part.body,
      ps_material: typeof part.material === 'string' ? part.material : JSON.stringify(part.material),
      ...(part.density !== undefined ? { ps_density: part.density } : {}),
      ...(part.friction !== undefined ? { ps_friction: part.friction } : {}),
      ...(part.restitution !== undefined ? { ps_restitution: part.restitution } : {}),
    };
    part.shapes.forEach((s, k) => g.add(shapeObject(s, `${part.id}_${s.type}${k}`, part.material)));
    root.add(g);
  }
  model.joints.forEach((j, k) => {
    const e = new THREE.Object3D();
    e.name = `JOINT_${j.id ?? k}`;
    e.position.set(...j.anchor);
    // Local +Z of the empty is the joint axis.
    e.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...j.axis).normalize());
    e.userData = { ps_joint: JSON.stringify(j) };
    root.add(e);
  });
  for (const sp of model.softParts) {
    const spec = resolveMaterial(sp.material);
    let geo: THREE.BufferGeometry;
    if (sp.type === 'cloth') geo = new THREE.PlaneGeometry(sp.size[0], sp.size[1], sp.resolution[0] - 1, sp.resolution[1] - 1);
    else if (sp.type === 'softbody') geo = sp.shape === 'box' ? new THREE.BoxGeometry(...sp.size) : new THREE.SphereGeometry(1, 24, 16).scale(...sp.size);
    else geo = new THREE.BoxGeometry(...sp.size);
    const m = new THREE.Mesh(geo, makeThreeMaterial(spec).clone());
    m.name = `SOFT_${sp.id}`;
    m.position.set(...sp.position);
    if (sp.type !== 'fluid') m.quaternion.copy(quatFromDeg(sp.rotation));
    m.userData = { ps_kind: sp.type, ps_soft: JSON.stringify(sp) };
    root.add(m);
  }
  return root;
}

export async function exportModelGLB(model: ModelDef): Promise<ArrayBuffer> {
  const scene = buildExportScene(model);
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(scene, { binary: true, onlyVisible: false });
  return result as ArrayBuffer;
}

export function exportModelJSON(model: ModelDef): string {
  return JSON.stringify(model, null, 2);
}
