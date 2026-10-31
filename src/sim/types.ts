import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { MaterialSpec, ModelDef, PartDef, PlacementDef, ShapeDef, SoftPartDef } from '../models/schema';

/** Collision proxy geometry in the shape's local frame, used by the particle solver. */
export type ProxyShape =
  | { kind: 'sphere'; r: number }
  | { kind: 'box'; hx: number; hy: number; hz: number }
  | { kind: 'capsule'; r: number; hh: number }
  | { kind: 'cylinder'; r: number; hh: number }
  | { kind: 'hull'; planes: Float32Array; radius: number }
  | { kind: 'trimesh'; vertices: Float32Array; indices: Uint32Array; radius: number };

export interface ShapeInstance {
  def: ShapeDef;
  /** Shape pose relative to its body. */
  localPos: THREE.Vector3;
  localQuat: THREE.Quaternion;
  proxy: ProxyShape | null;
  /** Bounding radius around the shape's local origin. */
  boundRadius: number;
  collider: RAPIER.Collider | null;
  visual: THREE.Object3D | null;
  spec: MaterialSpec;
}

export interface PartInstance {
  entity: Entity;
  def: PartDef;
  body: RAPIER.RigidBody;
  object: THREE.Group;
  shapes: ShapeInstance[];
  spec: MaterialSpec;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  currPos: THREE.Vector3;
  currQuat: THREE.Quaternion;
  boundRadius: number;
  /** Cross-section area used for air drag (m²). */
  area: number;
}

export interface SoftInstance {
  entity: Entity;
  def: SoftPartDef;
  /** Index range in the particle world. */
  start: number;
  count: number;
  object: THREE.Object3D;
  spec: MaterialSpec;
  /** Called each frame to push particle positions into the render mesh. */
  updateVisual(positions: Float32Array): void;
  dispose(): void;
}

export interface Entity {
  id: number;
  name: string;
  model: ModelDef;
  placement: PlacementDef;
  parts: PartInstance[];
  partById: Map<string, PartInstance>;
  joints: RAPIER.ImpulseJoint[];
  softs: SoftInstance[];
  /** Protected entities (the ground) cannot be deleted by tools. */
  locked?: boolean;
}
