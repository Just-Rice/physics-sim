import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { objectToModel, defaultImportOptions, isColliderName } from '../src/models/import/conventions';
import { buildExportScene } from '../src/models/export/exportModel';
import { parseModel, safeParseModel } from '../src/models/schema';
import { BUILTIN_MODELS } from '../src/models/builtin';
import { registerProceduralAssets } from '../src/models/assets';

registerProceduralAssets();

function box(name: string, size = 1): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial());
  m.name = name;
  return m;
}

/** Roughly what GLTFLoader produces for a Blender cart with two wheels and a hinge. */
function blenderCart(): THREE.Group {
  const scene = new THREE.Group();
  scene.name = 'Scene';
  const body = box('Body', 1);
  body.position.set(0, 0.5, 0);
  body.userData = { ps_body: 'dynamic', ps_material: 'wood', ps_density: 500 };
  const col = box('COL_Body', 1.1);
  col.position.set(0, 0.5, 0);
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.1, 16), new THREE.MeshStandardMaterial());
  wheel.name = 'Wheel';
  wheel.position.set(0.6, 0.3, 0);
  wheel.userData = { ps_material: 'rubber', ps_collider: 'hull' };
  const joint = new THREE.Object3D();
  joint.name = 'JOINT_axle';
  joint.position.set(0.6, 0.3, 0);
  joint.userData = { ps_joint: JSON.stringify({ type: 'hinge', a: 'Wheel', b: 'Body', motor: { velocity: 3, force: 20 }, limits: [-30, 30] }) };
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 4, 4), new THREE.MeshStandardMaterial());
  flag.name = 'Flag';
  flag.position.set(0, 2, 0);
  flag.userData = { ps_kind: 'cloth', ps_pinned: [[-0.5, 2.5, 0]], ps_attach: 'Body' };
  scene.add(body, col, wheel, joint, flag);
  return scene;
}

describe('import conventions', () => {
  it('recognises collider names', () => {
    expect(isColliderName('COL_Box')).toBe(true);
    expect(isColliderName('crate_col')).toBe(true);
    expect(isColliderName('UCX_thing')).toBe(true);
    expect(isColliderName('Collar')).toBe(false);
  });

  it('maps a Blender-style scene: one body per object, COL_ pieces, joints and cloth', () => {
    const opts = { ...defaultImportOptions('asset-1', 'Cart'), mode: 'per-object' as const };
    const { model, warnings } = objectToModel(blenderCart(), opts);
    expect(warnings).toEqual([]);
    const ids = model.parts.map((p) => p.id);
    expect(ids).toEqual(['body', 'wheel']);
    const body = model.parts.find((p) => p.id === 'body')!;
    expect(body.material).toBe('wood');
    expect(body.density).toBe(500);
    expect(body.shapes[0]).toMatchObject({ type: 'mesh', asset: 'asset-1', node: 'Body', collide: false });
    // COL_Body joins the Body part as its invisible collider
    expect(body.shapes[1]).toMatchObject({ node: 'COL_Body', visible: false, collide: true });
    const wheel = model.parts.find((p) => p.id === 'wheel')!;
    expect(wheel.material).toBe('rubber');
    expect(wheel.position).toEqual([0.6, 0.3, 0]);
    expect(model.joints).toHaveLength(1);
    expect(model.joints[0]).toMatchObject({ type: 'hinge', a: 'wheel', b: 'body', motor: { velocity: 3, force: 20 }, limits: [-30, 30] });
    expect(model.joints[0].anchor).toEqual([0.6, 0.3, 0]);
    expect(model.joints[0].axis).toEqual([0, 0, 1]);
    expect(model.softParts).toHaveLength(1);
    const cloth = model.softParts[0];
    expect(cloth.type).toBe('cloth');
    if (cloth.type === 'cloth') {
      expect(cloth.attachTo).toBe('body');
      expect(cloth.pinnedPoints).toEqual([[-0.5, 2.5, 0]]);
      expect(cloth.node).toBe('Flag');
    }
  });

  it('single-body import puts every mesh into one part, with COL_ pieces as the only colliders', () => {
    const { model } = objectToModel(blenderCart(), { ...defaultImportOptions('asset-2', 'Cart'), mode: 'single' });
    expect(model.parts).toHaveLength(1);
    const shapes = model.parts[0].shapes;
    expect(shapes.length).toBe(3); // Body, COL_Body, Wheel (Flag is cloth)
    const col = shapes.find((s) => s.type === 'mesh' && s.node === 'COL_Body')!;
    expect(col.visible).toBe(false);
    expect(col.collide).toBe(true);
    const visual = shapes.find((s) => s.type === 'mesh' && s.node === 'Body')!;
    expect(visual.collide).toBe(false);
    // Origin at the bottom centre
    expect(model.parts[0].position[1]).toBeCloseTo(-0.05, 5); // bottom of the lowest mesh (the 1.1 m collider)
  });

  it('fixed bodies default to exact trimesh colliders', () => {
    const scene = new THREE.Group();
    const m = box('Ramp');
    m.userData = { ps_body: 'fixed' };
    scene.add(m);
    const { model } = objectToModel(scene, { ...defaultImportOptions('a', 'Ramp'), mode: 'per-object' });
    expect(model.parts[0].body).toBe('fixed');
    expect(model.parts[0].shapes[0]).toMatchObject({ collider: 'trimesh' });
  });

  it('round-trips built-in models through the GLB export structure', () => {
    for (const id of ['car', 'newtons-cradle', 'flag', 'ragdoll', 'water-hose']) {
      const original = BUILTIN_MODELS.find((m) => m.id === id)!;
      const scene = buildExportScene(original);
      const { model } = objectToModel(scene, defaultImportOptions('asset-x', original.name));
      expect(model.parts.length).toBe(original.parts.length);
      expect(model.joints).toEqual(original.joints);
      expect(model.softParts).toEqual(original.softParts);
      for (let i = 0; i < original.parts.length; i++) {
        expect(model.parts[i].shapes.map((s) => s.type)).toEqual(original.parts[i].shapes.map((s) => s.type));
        expect(model.parts[i].position).toEqual(original.parts[i].position);
      }
    }
  });

  it('validates model JSON with helpful errors', () => {
    const ok = safeParseModel(JSON.parse(JSON.stringify(BUILTIN_MODELS[0])));
    expect(ok.ok).toBe(true);
    const bad = safeParseModel({ id: 'x', name: 'x', parts: [{ id: 'p', shapes: [{ type: 'sphere', radius: -1 }] }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/radius/);
    expect(() => parseModel({ id: 'y', name: 'y', joints: [{ type: 'nope', a: 'p', b: null, anchor: [0, 0, 0] }] })).toThrow();
  });
});

describe('own export wrapped by GLTFLoader', () => {
  it('finds the physics data one level down', () => {
    const original = BUILTIN_MODELS.find((m) => m.id === 'car')!;
    const wrapper = new THREE.Group();
    wrapper.add(buildExportScene(original));
    const { model } = objectToModel(wrapper, defaultImportOptions('asset-y', 'Car'));
    expect(model.joints).toEqual(original.joints);
    expect(model.parts.length).toBe(original.parts.length);
  });

  it('ignores invalid collider values instead of failing', () => {
    const scene = new THREE.Group();
    const m = box('Thing');
    m.userData = { ps_collider: 'cylinder' };
    scene.add(m);
    const { model } = objectToModel(scene, { ...defaultImportOptions('a', 'Thing'), mode: 'per-object' });
    expect(model.parts[0].shapes[0]).toMatchObject({ collider: 'hull' });
  });
});
