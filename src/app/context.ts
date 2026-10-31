import type * as THREE from 'three';
import type { SettingsStore } from './settings';
import type { Simulation } from '../sim/Simulation';
import type { RasterRenderer } from '../render/RasterRenderer';
import type { ModelLibrary } from '../models/library';
import type { Platform } from '../platform';
import type { Entity, PartInstance, SoftInstance } from '../sim/types';
import type { ModelDef } from '../models/schema';

export interface PickResult {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  part: PartInstance | null;
  soft: SoftInstance | null;
  object: THREE.Object3D;
  isGround: boolean;
}

/** Particle-side hooks the tools use (implemented by the particle plugin). */
export interface ParticleTools {
  grab(soft: SoftInstance, point: THREE.Vector3): number;
  moveGrab(id: number, target: THREE.Vector3): void;
  release(id: number): void;
  explode(center: THREE.Vector3, strength: number, radius: number): void;
  attract(center: THREE.Vector3, strength: number, radius: number, dt: number): void;
  pickables(): THREE.Object3D[];
  softFromObject(o: THREE.Object3D): SoftInstance | null;
}

export interface AppContext {
  settings: SettingsStore;
  sim: Simulation;
  view: RasterRenderer;
  library: ModelLibrary;
  platform: Platform;
  particles: ParticleTools | null;
  selected: PartInstance | null;
  select(part: PartInstance | null): void;
  toast(message: string, kind?: 'info' | 'error'): void;
  pick(clientX: number, clientY: number): PickResult | null;
  ray(clientX: number, clientY: number): THREE.Ray;
  spawnModel(model: ModelDef | string, position: THREE.Vector3, opts?: { yaw?: number; velocity?: THREE.Vector3; alignToSurface?: boolean }): Entity | null;
  removeEntity(e: Entity): void;
  /** Visual-only effect hooks */
  flash(point: THREE.Vector3, radius: number, color?: number): void;
}
