import type { JointInput, MaterialRef, PartInput, ShapeInput } from '../schema';

type V3 = [number, number, number];
type ShapeExtra = { position?: V3; rotation?: V3; material?: MaterialRef; visible?: boolean; collide?: boolean };

export const box = (size: V3, extra: ShapeExtra = {}): ShapeInput => ({ type: 'box', size, ...extra });
export const sphere = (radius: number, extra: ShapeExtra = {}): ShapeInput => ({ type: 'sphere', radius, ...extra });
export const cyl = (radius: number, height: number, extra: ShapeExtra = {}): ShapeInput => ({ type: 'cylinder', radius, height, ...extra });
export const capsule = (radius: number, height: number, extra: ShapeExtra = {}): ShapeInput => ({ type: 'capsule', radius, height, ...extra });
export const cone = (radius: number, height: number, extra: ShapeExtra = {}): ShapeInput => ({ type: 'cone', radius, height, ...extra });
export const mesh = (asset: string, extra: ShapeExtra & { scale?: V3; collider?: 'hull' | 'box' | 'sphere' | 'trimesh' } = {}): ShapeInput => ({ type: 'mesh', asset, ...extra });

export const part = (id: string, shapes: ShapeInput[], extra: Omit<PartInput, 'id' | 'shapes'> = {}): PartInput => ({
  id,
  name: extra.name ?? id,
  shapes,
  ...extra,
});

/** Single-part model helper. */
export const single = (shapes: ShapeInput[], extra: Omit<PartInput, 'id' | 'shapes'> = {}): PartInput[] => [part('body', shapes, extra)];

export const hinge = (a: string, b: string | null, anchor: V3, axis: V3, extra: Partial<JointInput> = {}): JointInput => ({ type: 'hinge', a, b, anchor, axis, ...extra });
export const ball = (a: string, b: string | null, anchor: V3, extra: Partial<JointInput> = {}): JointInput => ({ type: 'ball', a, b, anchor, ...extra });
export const fixedJoint = (a: string, b: string | null, anchor: V3): JointInput => ({ type: 'fixed', a, b, anchor });
