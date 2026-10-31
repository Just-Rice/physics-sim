import * as THREE from 'three';
import { RAPIER, RigidWorld } from '../physics/RigidWorld';
import { applyAttractors, applyNBody } from '../physics/gravity';
import { applyAirDrag, windAt } from '../physics/fields';
import { destroyEntityRigid, instantiateModel, type InstantiateContext } from '../models/instantiate';
import type { ModelDef, PlacementDef } from '../models/schema';
import { parseModel } from '../models/schema';
import type { SettingsStore } from '../app/settings';
import type { Entity, PartInstance } from './types';

export interface SimPlugin {
  /** After the rigid step: particles, trails, etc. */
  afterStep?(dt: number): void;
  /** Called before an entity is destroyed (e.g. remove its soft parts). */
  onEntityRemoved?(e: Entity): void;
  /** Called after a model is instantiated (create soft parts). */
  onEntityCreated?(e: Entity): void;
  /** Visual sync each frame. */
  sync?(alpha: number): void;
}

const GROUND_MODEL: ModelDef = parseModel({
  id: '__ground',
  name: 'Ground',
  category: 'Basics',
  parts: [{
    id: 'ground',
    name: 'Ground',
    body: 'fixed',
    material: 'ground',
    restitution: 0.5,
    position: [0, -1, 0],
    shapes: [{ type: 'box', size: [200, 2, 200], visible: false }],
  }],
});

/**
 * The simulation: a Rapier world plus entities built from ModelDefs, force
 * fields, plugins (particles, trails) and render interpolation.
 */
export class Simulation {
  readonly rigid: RigidWorld;
  readonly root = new THREE.Group();
  readonly entities: Entity[] = [];
  readonly parts: PartInstance[] = [];
  private plugins: SimPlugin[] = [];
  private idCounter = 1;
  private worldBody: RAPIER.RigidBody;
  ground: Entity;
  private accumulator = 0;
  stepCount = 0;
  /** Forces from tools (grab, attract) applied every step. */
  readonly stepForces: ((dt: number) => void)[] = [];

  constructor(readonly settings: SettingsStore) {
    this.rigid = new RigidWorld();
    this.root.name = 'entities';
    this.worldBody = this.rigid.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.ground = this.spawn(GROUND_MODEL, { model: '__ground', position: [0, 0, 0], rotation: [0, 0, 0] });
    this.ground.locked = true;
    this.applyGravitySettings();
    this.rigid.setSolverIterations(settings.data.physics.solverIterations);

    this.rigid.onBeforeStep((dt) => this.applyFields(dt));
    settings.on((path) => {
      if (path.startsWith('physics.gravity') || path === 'physics.G') this.applyGravitySettings();
      if (path === 'physics.solverIterations') this.rigid.setSolverIterations(settings.data.physics.solverIterations);
    });
  }

  addPlugin(p: SimPlugin): void {
    this.plugins.push(p);
  }

  get ctx(): InstantiateContext {
    return {
      world: this.rigid.world,
      worldBody: this.worldBody,
      parent: this.root,
      nextId: () => this.idCounter++,
    };
  }

  get time(): number {
    return this.rigid.time;
  }

  get wind(): { x: number; y: number; z: number } {
    const p = this.settings.data.physics;
    return windAt(p.windX, p.windZ, p.windGust, this.rigid.time);
  }

  applyGravitySettings(): void {
    const p = this.settings.data.physics;
    if (p.gravityMode === 'uniform') this.rigid.setGravity(0, -p.gravity, 0);
    else this.rigid.setGravity(0, 0, 0);
    // Wake everything so a gravity change is felt immediately.
    this.rigid.world.forEachRigidBody((b) => b.isDynamic() && b.wakeUp());
  }

  setGroundEnabled(on: boolean): void {
    for (const p of this.ground.parts) for (const s of p.shapes) s.collider?.setEnabled(on);
  }

  spawn(model: ModelDef, placement: PlacementDef): Entity {
    const e = instantiateModel(this.ctx, model, placement);
    this.entities.push(e);
    this.parts.push(...e.parts);
    for (const p of this.plugins) p.onEntityCreated?.(e);
    return e;
  }

  remove(e: Entity): void {
    if (e.locked) return;
    for (const p of this.plugins) p.onEntityRemoved?.(e);
    destroyEntityRigid(this.rigid.world, e);
    const i = this.entities.indexOf(e);
    if (i >= 0) this.entities.splice(i, 1);
    for (const part of e.parts) {
      const k = this.parts.indexOf(part);
      if (k >= 0) this.parts.splice(k, 1);
    }
  }

  clear(): void {
    for (const e of [...this.entities]) if (!e.locked) this.remove(e);
    this.rigid.time = 0;
  }

  /** Find the part (if any) an Object3D belongs to. */
  partFromObject(o: THREE.Object3D | null): PartInstance | null {
    while (o) {
      if (o.userData.part) return o.userData.part as PartInstance;
      o = o.parent;
    }
    return null;
  }

  private applyFields(dt: number): void {
    const p = this.settings.data.physics;
    if (p.gravityMode === 'nbody' || p.gravityMode === 'attractors') {
      // The ground slab is not a gravity source.
      const bodies = this.parts.filter((x) => !x.entity.locked);
      if (p.gravityMode === 'nbody') applyNBody(bodies, p.G, dt);
      else applyAttractors(bodies, p.G, dt);
    }
    if (p.airDrag || p.windX !== 0 || p.windZ !== 0) {
      applyAirDrag(this.parts, p.airDrag ? p.airDensity : p.airDensity * 0.25, this.wind);
    }
    for (const f of this.stepForces) f(dt);
  }

  /** Advance one fixed step. */
  stepOnce(): void {
    for (const part of this.parts) {
      part.prevPos.copy(part.currPos);
      part.prevQuat.copy(part.currQuat);
    }
    this.rigid.step();
    for (const pl of this.plugins) pl.afterStep?.(this.rigid.dt);
    for (const part of this.parts) {
      const t = part.body.translation();
      const r = part.body.rotation();
      part.currPos.set(t.x, t.y, t.z);
      part.currQuat.set(r.x, r.y, r.z, r.w);
    }
    this.stepCount++;
  }

  /**
   * Feed real elapsed time (seconds). Runs as many fixed steps as needed,
   * scaled by the time-scale setting, and returns the interpolation alpha.
   */
  advance(realDt: number): number {
    const p = this.settings.data.physics;
    if (p.paused) return 1;
    const dt = this.rigid.dt;
    this.accumulator += Math.min(realDt, 0.1) * p.timeScale;
    let steps = 0;
    const maxSteps = 8;
    while (this.accumulator >= dt && steps < maxSteps) {
      this.stepOnce();
      this.accumulator -= dt;
      steps++;
    }
    if (steps === maxSteps) this.accumulator = 0; // drop time instead of spiralling
    return this.accumulator / dt;
  }

  /** Single step while paused. */
  stepManual(): void {
    this.stepOnce();
    this.sync(1);
  }

  sync(alpha: number): void {
    for (const part of this.parts) {
      part.object.position.lerpVectors(part.prevPos, part.currPos, alpha);
      part.object.quaternion.slerpQuaternions(part.prevQuat, part.currQuat, alpha);
    }
    for (const pl of this.plugins) pl.sync?.(alpha);
  }

  /** Teleport a part (used by tools/builder) and reset interpolation. */
  setPartPose(part: PartInstance, pos: THREE.Vector3, quat?: THREE.Quaternion): void {
    part.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    if (quat) part.body.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true);
    part.currPos.copy(pos);
    part.prevPos.copy(pos);
    if (quat) {
      part.currQuat.copy(quat);
      part.prevQuat.copy(quat);
    }
  }

  stats(): { bodies: number; kinetic: number; potential: number; momentum: number } {
    let kinetic = 0, potential = 0, momentum = 0;
    const g = this.settings.data.physics.gravityMode === 'uniform' ? this.settings.data.physics.gravity : 0;
    for (const p of this.parts) {
      const b = p.body;
      if (!b.isDynamic()) continue;
      const m = b.mass();
      const v = b.linvel();
      const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
      kinetic += 0.5 * m * v2;
      const w = b.angvel();
      const inertia = b.principalInertia();
      kinetic += 0.5 * (inertia.x * w.x * w.x + inertia.y * w.y * w.y + inertia.z * w.z * w.z);
      potential += m * g * b.worldCom().y;
      momentum += m * Math.sqrt(v2);
    }
    return { bodies: this.parts.length - this.ground.parts.length, kinetic, potential, momentum };
  }
}
