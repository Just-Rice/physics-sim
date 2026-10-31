import { z } from 'zod';

/**
 * One JSON model format is shared by the built-in library, the Model Builder,
 * imported files and exports. Positions are metres, rotations are Euler angles
 * in degrees (XYZ order) so the files stay easy to read and hand-edit.
 */

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

export const MaterialSpec = z.object({
  color: z.string().default('#cccccc'),
  metalness: z.number().min(0).max(1).default(0),
  roughness: z.number().min(0).max(1).default(0.5),
  transmission: z.number().min(0).max(1).default(0),
  ior: z.number().min(1).max(3).default(1.5),
  thickness: z.number().min(0).default(0.5),
  clearcoat: z.number().min(0).max(1).default(0),
  sheen: z.number().min(0).max(1).default(0),
  emissive: z.string().default('#000000'),
  emissiveIntensity: z.number().min(0).default(0),
  opacity: z.number().min(0).max(1).default(1),
  // Physics side of the material
  density: z.number().positive().default(1000),
  friction: z.number().min(0).default(0.5),
  restitution: z.number().min(0).max(1).default(0.3),
});
export type MaterialSpec = z.infer<typeof MaterialSpec>;

/** A preset id (see materials.ts) or an inline spec, optionally starting from a preset. */
export const MaterialRef = z.union([z.string(), MaterialSpec.partial().extend({ preset: z.string().optional() })]);
export type MaterialRef = z.infer<typeof MaterialRef>;

const shapeBase = {
  position: Vec3.default([0, 0, 0]),
  rotation: Vec3.default([0, 0, 0]),
  material: MaterialRef.optional(),
  /** false = collision only (invisible) */
  visible: z.boolean().default(true),
  /** false = visual only (no collider) */
  collide: z.boolean().default(true),
};

export const ColliderKind = z.enum(['hull', 'box', 'sphere', 'trimesh']);
export type ColliderKind = z.infer<typeof ColliderKind>;

export const ShapeDef = z.discriminatedUnion('type', [
  z.object({ type: z.literal('box'), size: Vec3, ...shapeBase }),
  z.object({ type: z.literal('sphere'), radius: z.number().positive(), ...shapeBase }),
  z.object({ type: z.literal('cylinder'), radius: z.number().positive(), height: z.number().positive(), ...shapeBase }),
  z.object({ type: z.literal('capsule'), radius: z.number().positive(), height: z.number().positive(), ...shapeBase }),
  z.object({ type: z.literal('cone'), radius: z.number().positive(), height: z.number().positive(), ...shapeBase }),
  z.object({
    type: z.literal('mesh'),
    /** Asset id of a stored GLB (imported) or a procedural mesh id ("proc:teapot"). */
    asset: z.string(),
    /** Optional node name inside the asset; omitted = whole asset. */
    node: z.string().optional(),
    scale: Vec3.default([1, 1, 1]),
    collider: ColliderKind.default('hull'),
    ...shapeBase,
  }),
]);
export type ShapeDef = z.infer<typeof ShapeDef>;
export type ShapeType = ShapeDef['type'];

export const BodyType = z.enum(['dynamic', 'fixed', 'kinematic']);
export type BodyType = z.infer<typeof BodyType>;

export const PartDef = z.object({
  id: z.string(),
  name: z.string().default('Part'),
  position: Vec3.default([0, 0, 0]),
  rotation: Vec3.default([0, 0, 0]),
  body: BodyType.default('dynamic'),
  material: MaterialRef.default('plastic'),
  density: z.number().positive().optional(),
  friction: z.number().min(0).optional(),
  restitution: z.number().min(0).max(1).optional(),
  linearDamping: z.number().min(0).default(0),
  angularDamping: z.number().min(0).default(0.05),
  gravityScale: z.number().default(1),
  ccd: z.boolean().default(false),
  initialVelocity: Vec3.optional(),
  initialAngularVelocity: Vec3.optional(),
  /** Marks this body as a gravity source in point-attractor mode. */
  attractor: z.boolean().default(false),
  shapes: z.array(ShapeDef).min(1),
});
export type PartDef = z.infer<typeof PartDef>;

export const JointType = z.enum(['fixed', 'ball', 'hinge', 'slider', 'spring', 'rope']);
export type JointType = z.infer<typeof JointType>;

export const JointDef = z.object({
  id: z.string().optional(),
  type: JointType,
  a: z.string(),
  /** Part id, or null to attach to the world. */
  b: z.string().nullable(),
  /** Anchor in model space (shared by both bodies at rest). */
  anchor: Vec3,
  /** Optional second anchor (model space) for springs and ropes. */
  anchorB: Vec3.optional(),
  /** Axis in model space for hinge / slider. */
  axis: Vec3.default([0, 0, 1]),
  /** Limits: degrees for hinge, metres for slider. */
  limits: z.tuple([z.number(), z.number()]).optional(),
  motor: z.object({
    /** rad/s for hinge, m/s for slider */
    velocity: z.number(),
    /** Motor strength factor. */
    force: z.number().positive().default(50),
  }).optional(),
  stiffness: z.number().positive().default(200),
  damping: z.number().min(0).default(5),
  /** Rest length (spring) or max length (rope); defaults to anchor distance. */
  length: z.number().positive().optional(),
  /** Allow the two bodies to collide with each other. */
  collide: z.boolean().default(false),
});
export type JointDef = z.infer<typeof JointDef>;

export const PinMode = z.enum(['none', 'top-edge', 'top-corners', 'corners', 'left-edge', 'all-edges']);
export type PinMode = z.infer<typeof PinMode>;

export const SoftPartDef = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('cloth'),
    id: z.string(),
    name: z.string().default('Cloth'),
    position: Vec3.default([0, 0, 0]),
    rotation: Vec3.default([0, 0, 0]),
    /** width (x) and height (y) in metres; the sheet lies in its local XY plane */
    size: z.tuple([z.number().positive(), z.number().positive()]).default([2, 2]),
    resolution: z.tuple([z.number().int().min(2), z.number().int().min(2)]).default([24, 24]),
    /** kg per square metre */
    areaDensity: z.number().positive().default(0.3),
    stretch: z.number().min(0).default(0),
    bend: z.number().min(0).default(0.02),
    pins: PinMode.default('none'),
    /** Extra pinned points (model space) matched to the nearest particle. */
    pinnedPoints: z.array(Vec3).default([]),
    /** Part that pinned particles follow; null = pinned to the world. */
    attachTo: z.string().nullable().default(null),
    /** Imported mesh to use instead of a grid. */
    asset: z.string().optional(),
    node: z.string().optional(),
    material: MaterialRef.default('fabric'),
  }),
  z.object({
    type: z.literal('softbody'),
    id: z.string(),
    name: z.string().default('Soft body'),
    position: Vec3.default([0, 0, 0]),
    rotation: Vec3.default([0, 0, 0]),
    shape: z.enum(['sphere', 'box', 'torus', 'mesh']).default('sphere'),
    size: Vec3.default([0.5, 0.5, 0.5]),
    detail: z.number().int().min(0).max(4).default(2),
    asset: z.string().optional(),
    node: z.string().optional(),
    mass: z.number().positive().default(2),
    /** Edge stiffness compliance (0 = rigid edges). */
    compliance: z.number().min(0).default(0.0005),
    /** 1 = keep rest volume, >1 inflates like a balloon. */
    pressure: z.number().min(0).default(1),
    /** 0..1 pull towards the rest shape (jelly). */
    shapeMatching: z.number().min(0).max(1).default(0.15),
    material: MaterialRef.default('jelly'),
  }),
  z.object({
    type: z.literal('fluid'),
    id: z.string(),
    name: z.string().default('Water'),
    position: Vec3.default([0, 0, 0]),
    /** Block size; filled with particles at the global fluid spacing. */
    size: Vec3.default([0.6, 0.6, 0.6]),
    viscosity: z.number().min(0).max(1).default(0.02),
    /** If set, particles are emitted over time instead of filling a block. */
    emitter: z.object({
      rate: z.number().positive().default(300),
      velocity: Vec3.default([0, 0, 2]),
      radius: z.number().positive().default(0.08),
      total: z.number().int().positive().default(1500),
    }).optional(),
    material: MaterialRef.default('water'),
  }),
]);
export type SoftPartDef = z.infer<typeof SoftPartDef>;

export const ModelCategory = z.enum(['Basics', 'Materials', 'Machines', 'Structures', 'Soft & Fluid', 'Space', 'Fun', 'My Models']);
export type ModelCategory = z.infer<typeof ModelCategory>;

export const ModelDef = z.object({
  format: z.literal('physics-sim-model').default('physics-sim-model'),
  version: z.literal(1).default(1),
  id: z.string(),
  name: z.string(),
  category: ModelCategory.default('My Models'),
  description: z.string().default(''),
  parts: z.array(PartDef).default([]),
  joints: z.array(JointDef).default([]),
  softParts: z.array(SoftPartDef).default([]),
});
export type ModelDef = z.infer<typeof ModelDef>;
/** Loosely typed input form (defaults not yet applied) used when authoring models in code. */
export type ModelInput = z.input<typeof ModelDef>;
export type PartInput = z.input<typeof PartDef>;
export type ShapeInput = z.input<typeof ShapeDef>;
export type JointInput = z.input<typeof JointDef>;
export type SoftPartInput = z.input<typeof SoftPartDef>;

export function parseModel(input: unknown): ModelDef {
  return ModelDef.parse(input);
}

export function safeParseModel(input: unknown): { ok: true; model: ModelDef } | { ok: false; error: string } {
  const r = ModelDef.safeParse(input);
  if (r.success) return { ok: true, model: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n') };
}

/** A placed model inside a scene. */
export const PlacementDef = z.object({
  model: z.string(),
  position: Vec3.default([0, 0, 0]),
  rotation: Vec3.default([0, 0, 0]),
  /** Optional per-placement overrides */
  velocity: Vec3.optional(),
  material: MaterialRef.optional(),
});
export type PlacementDef = z.infer<typeof PlacementDef>;
