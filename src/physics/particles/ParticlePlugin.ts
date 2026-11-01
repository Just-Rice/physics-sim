import * as THREE from 'three';
import type { SimPlugin, Simulation } from '../../sim/Simulation';
import type { Entity, PartInstance, SoftInstance } from '../../sim/types';
import type { ParticleTools } from '../../app/context';
import type { SettingsStore } from '../../app/settings';
import { FLAG_FLUID, ParticleWorld, type StepOptions } from './ParticleWorld';
import { PROXY_STRIDE, ProxySet, ProxyType, type TrimeshData } from './collision';
import { addEmitter, buildCloth, buildSoftBody, fillFluid, initFluidParticle, type Transform } from './builders';
import { placementMatrix } from '../../models/instantiate';
import { makeThreeMaterial, resolveMaterial } from '../../models/materials';
import { FluidRenderer } from '../../render/fluidSurface';
import { ParticleThreads, autoThreadCount, canUseThreads } from './scheduler';
import type { SoftPartDef } from '../../models/schema';

/** Something that can advance the particle world: inline (this thread) or a worker. */
export interface ParticleStepper {
  step(world: ParticleWorld, opt: StepOptions): void;
  readonly threads: number;
}

export const inlineStepper: ParticleStepper = {
  threads: 1,
  step(world, opt) {
    world.step(opt);
  },
};

interface SoftRecord {
  inst: SoftInstance;
  owner: number;
  mesh: THREE.Mesh | null;
  attachments: { particle: number; part: PartInstance | null; local: [number, number, number] }[];
}

const trimeshCache = new WeakMap<Float32Array, TrimeshData>();

/**
 * Bridges the XPBD particle world with the rigid simulation: builds soft
 * parts when models spawn, gives particles collision proxies for every rigid
 * shape, feeds reaction impulses back to Rapier, and draws the results.
 */
export class ParticlePlugin implements SimPlugin, ParticleTools {
  readonly world = new ParticleWorld(8192, canUseThreads());
  private threads: ParticleThreads | null = null;
  readonly group = new THREE.Group();
  readonly fluid = new FluidRenderer();
  private proxies = new ProxySet();
  private records: SoftRecord[] = [];
  private ownerCounter = 1;
  private bodyPoses = new Float32Array(0);
  private bodyCom = new Float32Array(0);
  private impulses = new Float64Array(0);
  stepper: ParticleStepper = inlineStepper;
  private lastKinetic = 0;
  /** Particles moved since the last visual update. */
  private dirty = true;
  private lastTrace = false;
  lastStepMs = 0;

  constructor(private sim: Simulation, private settings: SettingsStore, private traceActive: () => boolean) {
    this.group.name = 'soft-bodies';
    this.group.add(this.fluid.group);
    this.world.setFluidRadius(settings.data.particles.fluidRadius);
    this.fluid.mode = settings.data.particles.fluidRender;
    settings.on((p) => {
      if (p === 'particles.fluidRadius') this.world.setFluidRadius(settings.data.particles.fluidRadius);
      if (p === 'particles.fluidRender') this.fluid.mode = settings.data.particles.fluidRender;
      if (p === 'particles.threads') this.configureThreads();
    });
    this.configureThreads();
  }

  /** Number of threads in use (1 = single-threaded). */
  get threadCount(): number {
    return this.threads?.active ? this.threads.threads : 1;
  }

  private configureThreads(): void {
    this.threads?.stop();
    this.threads = null;
    this.world.parallel = null;
    if (!this.world.shared) return;
    const want = this.settings.data.particles.threads || autoThreadCount();
    if (want < 2) return;
    this.threads = new ParticleThreads(want);
    this.threads.prewarm(this.world);
    this.world.parallel = this.threads;
  }

  private get maxParticles(): number {
    return this.settings.data.particles.maxParticles;
  }

  // ------------------------------------------------------------------ lifecycle

  onEntityCreated(e: Entity): void {
    if (!e.model.softParts.length) return;
    const T: Transform = (() => {
      const m = placementMatrix(e.placement);
      return { pos: m.pos, quat: m.quat };
    })();
    let skipped = 0;
    const before = this.world.count;
    for (const def of e.model.softParts) {
      if (!this.addSoft(e, def, T)) skipped++;
    }
    // Thrown or fired soft parts (cannon jelly, water) keep the spawn velocity.
    const v = e.placement.velocity;
    if (v) {
      const w = this.world;
      for (let i = before; i < w.count; i++) {
        if (w.invMass[i] === 0) continue;
        w.vel[i * 3] = v[0];
        w.vel[i * 3 + 1] = v[1];
        w.vel[i * 3 + 2] = v[2];
      }
      for (const em of w.emitters) {
        if (this.records.some((r) => r.owner === em.owner && r.inst.entity === e)) {
          em.velocity = [em.velocity[0] + v[0], em.velocity[1] + v[1], em.velocity[2] + v[2]];
        }
      }
    }
    this.dirty = true;
    if (skipped) this.onBudget?.(skipped);
  }

  /** Called when particles couldn't be created because of the budget. */
  onBudget?: (skipped: number) => void;

  private addSoft(e: Entity, def: SoftPartDef, T: Transform): boolean {
    const owner = this.ownerCounter++;
    const spec = resolveMaterial(def.material, def.type === 'cloth' ? 'fabric' : def.type === 'fluid' ? 'water' : 'jelly');
    if (def.type === 'fluid') {
      if (def.emitter) addEmitter(this.world, def, T, owner);
      else if (fillFluid(this.world, def, T, owner, this.maxParticles) === 0) return false;
      const obj = new THREE.Group();
      const inst: SoftInstance = { entity: e, def, start: 0, count: 0, object: obj, spec, updateVisual: () => {}, dispose: () => {} };
      e.softs.push(inst);
      this.records.push({ inst, owner, mesh: null, attachments: [] });
      return true;
    }
    const built = def.type === 'cloth' ? buildCloth(this.world, def, T, owner, this.maxParticles) : buildSoftBody(this.world, def, T, owner, this.maxParticles);
    if (!built) return false;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(built.count * 3);
    pos.set(this.world.pos.subarray(built.start * 3, (built.start + built.count) * 3));
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    if (built.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(built.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(built.index, 1));
    geo.computeVertexNormals();
    const mat = makeThreeMaterial(spec, { side: def.type === 'cloth' ? THREE.DoubleSide : THREE.FrontSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = def.name;
    const rec: SoftRecord = { inst: null as unknown as SoftInstance, owner, mesh, attachments: [] };
    const inst: SoftInstance = {
      entity: e,
      def,
      start: built.start,
      count: built.count,
      object: mesh,
      spec,
      updateVisual: (positions) => {
        const attr = geo.getAttribute('position') as THREE.BufferAttribute;
        (attr.array as Float32Array).set(positions.subarray(inst.start * 3, (inst.start + inst.count) * 3));
        attr.needsUpdate = true;
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
      },
      dispose: () => {
        mesh.removeFromParent();
        geo.dispose();
      },
    };
    rec.inst = inst;
    mesh.userData.soft = inst;
    // Pins: attach to a part, or fix in the world
    if (def.type === 'cloth' && built.pins.length) {
      const part = def.attachTo ? e.partById.get(def.attachTo) ?? null : null;
      for (const local of built.pins) {
        const i = built.start + local;
        const wp = new THREE.Vector3(this.world.pos[i * 3], this.world.pos[i * 3 + 1], this.world.pos[i * 3 + 2]);
        if (part) {
          const t = part.body.translation(), r = part.body.rotation();
          const lp = wp.sub(new THREE.Vector3(t.x, t.y, t.z)).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w).invert());
          rec.attachments.push({ particle: i, part, local: [lp.x, lp.y, lp.z] });
        } else {
          // World pins are immovable.
          this.world.invMass[i] = 0;
          rec.attachments.push({ particle: i, part: null, local: [wp.x, wp.y, wp.z] });
        }
      }
    }
    e.softs.push(inst);
    this.records.push(rec);
    this.syncAttachments();
    this.group.add(mesh);
    return true;
  }

  /** Rebuild the world's attachment list (particle indices change when objects are removed). */
  private syncAttachments(): void {
    this.world.attachments = [];
    for (const r of this.records) {
      for (const a of r.attachments) this.world.attachments.push({ particle: a.particle, slot: -1, local: a.local });
    }
  }

  onEntityRemoved(e: Entity): void {
    const remove = this.records.filter((r) => r.inst.entity === e);
    if (!remove.length) return;
    for (const r of remove) {
      this.world.removeOwner(r.owner);
      r.inst.dispose();
    }
    this.records = this.records.filter((r) => r.inst.entity !== e);
    this.reindex();
    this.dirty = true;
  }

  /** After removal, find each object's new start (its particles stay contiguous). */
  private reindex(): void {
    const firstOf = new Map<number, number>();
    for (let i = 0; i < this.world.count; i++) {
      const o = this.world.owner[i];
      if (!firstOf.has(o)) firstOf.set(o, i);
    }
    for (const r of this.records) {
      if (!r.mesh) continue;
      const s = firstOf.get(r.owner);
      if (s === undefined) continue;
      const delta = s - r.inst.start;
      r.inst.start = s;
      for (const a of r.attachments) a.particle += delta;
    }
    this.syncAttachments();
  }

  reset(): void {
    for (const r of this.records) r.inst.dispose();
    this.records = [];
    this.world.clear();
    this.dirty = true;
  }

  // ------------------------------------------------------------------ stepping

  private buildProxies(parts: PartInstance[]): void {
    const set = this.proxies;
    set.clear();
    const nb = parts.length;
    if (this.bodyPoses.length < nb * 7) {
      this.bodyPoses = new Float32Array(nb * 7 * 2);
      this.bodyCom = new Float32Array(nb * 3 * 2);
      this.impulses = new Float64Array(nb * 6 * 2);
    }
    this.impulses.fill(0);
    const bq = new THREE.Quaternion();
    const bp = new THREE.Vector3();
    const sq = new THREE.Quaternion();
    const sp = new THREE.Vector3();
    for (let slot = 0; slot < nb; slot++) {
      const part = parts[slot];
      const b = part.body;
      if (!b.isValid()) continue;
      const t = b.translation(), r = b.rotation();
      bp.set(t.x, t.y, t.z);
      bq.set(r.x, r.y, r.z, r.w);
      const o7 = slot * 7;
      this.bodyPoses[o7] = t.x; this.bodyPoses[o7 + 1] = t.y; this.bodyPoses[o7 + 2] = t.z;
      this.bodyPoses[o7 + 3] = r.x; this.bodyPoses[o7 + 4] = r.y; this.bodyPoses[o7 + 5] = r.z; this.bodyPoses[o7 + 6] = r.w;
      if (part.entity.locked) continue; // the ground is handled analytically
      const com = b.worldCom();
      this.bodyCom[slot * 3] = com.x; this.bodyCom[slot * 3 + 1] = com.y; this.bodyCom[slot * 3 + 2] = com.z;
      const lv = b.linvel(), av = b.angvel();
      const dynamic = b.isDynamic();
      for (const s of part.shapes) {
        if (!s.proxy || !s.collider || !s.collider.isEnabled()) continue;
        sp.copy(s.localPos).applyQuaternion(bq).add(bp);
        sq.copy(bq).multiply(s.localQuat);
        const o = set.push();
        const d = set.data;
        d[o + 1] = sp.x; d[o + 2] = sp.y; d[o + 3] = sp.z;
        d[o + 4] = sq.x; d[o + 5] = sq.y; d[o + 6] = sq.z; d[o + 7] = sq.w;
        const R = s.boundRadius + 0.02;
        d[o + 12] = sp.x - R; d[o + 13] = sp.y - R; d[o + 14] = sp.z - R;
        d[o + 15] = sp.x + R; d[o + 16] = sp.y + R; d[o + 17] = sp.z + R;
        d[o + 18] = s.spec.friction;
        d[o + 19] = slot;
        d[o + 20] = lv.x; d[o + 21] = lv.y; d[o + 22] = lv.z;
        d[o + 23] = av.x; d[o + 24] = av.y; d[o + 25] = av.z;
        d[o + 26] = com.x; d[o + 27] = com.y; d[o + 28] = com.z;
        d[o + 31] = dynamic ? 1 / Math.max(b.mass(), 1e-3) : 0;
        const px = s.proxy;
        switch (px.kind) {
          case 'sphere': d[o] = ProxyType.Sphere; d[o + 8] = px.r; break;
          case 'box': d[o] = ProxyType.Box; d[o + 8] = px.hx; d[o + 9] = px.hy; d[o + 10] = px.hz; break;
          case 'capsule': d[o] = ProxyType.Capsule; d[o + 8] = px.r; d[o + 9] = px.hh; break;
          case 'cylinder': d[o] = ProxyType.Cylinder; d[o + 8] = px.r; d[o + 9] = px.hh; break;
          case 'hull': {
            d[o] = ProxyType.Hull;
            d[o + 29] = set.addPlanes(px.planes);
            d[o + 30] = px.planes.length / 4;
            break;
          }
          case 'trimesh': {
            d[o] = ProxyType.Trimesh;
            let tm = trimeshCache.get(px.vertices);
            if (!tm) {
              tm = { vertices: px.vertices, indices: px.indices };
              trimeshCache.set(px.vertices, tm);
            }
            d[o + 29] = set.trimeshes.length;
            set.trimeshes.push(tm);
            break;
          }
        }
      }
    }
  }

  afterStep(dt: number): void {
    const w = this.world;
    const ps = this.settings.data.particles;
    if (w.emitters.length) {
      w.runEmitters(dt, this.maxParticles, (e, i) => initFluidParticle(w, i, w.pos[i * 3], w.pos[i * 3 + 1], w.pos[i * 3 + 2], 1000 * (2 * w.fluidRadius) ** 3, e.viscosity, e.owner));
    }
    if (w.count === 0) return;
    const parts = this.sim.parts;
    this.buildProxies(parts);
    // Attachment slots follow the current parts list
    const slotOf = new Map<PartInstance, number>();
    parts.forEach((p, i) => slotOf.set(p, i));
    // A pin whose part was deleted lets go (its coordinates are body-local, so
    // keeping it as a world pin would teleport the particle).
    let dropped = false;
    for (const r of this.records) {
      const keep = r.attachments.filter((a) => !a.part || slotOf.has(a.part));
      if (keep.length !== r.attachments.length) {
        r.attachments = keep;
        dropped = true;
      }
    }
    if (dropped) this.syncAttachments();
    let ai = 0;
    for (const r of this.records) for (const a of r.attachments) {
      const wa = w.attachments[ai++];
      if (!wa) continue;
      wa.particle = a.particle;
      wa.slot = a.part ? slotOf.get(a.part)! : -1;
      wa.local = a.local;
    }
    const ph = this.settings.data.physics;
    const wind = this.sim.wind;
    const t0 = performance.now();
    this.stepper.step(w, {
      dt,
      substeps: ps.substeps,
      fluidIterations: ps.fluidIterations,
      gravity: ph.gravityMode === 'uniform' ? [0, -ph.gravity, 0] : [0, 0, 0],
      wind: [wind.x, wind.y, wind.z],
      airDensity: ph.airDrag ? ph.airDensity : 0,
      ground: this.sim.ground.parts[0].shapes[0].collider?.isEnabled() ?? true,
      proxies: this.proxies,
      bodyPoses: this.bodyPoses,
      bodyCom: this.bodyCom,
      impulses: this.impulses,
    });
    this.lastStepMs = performance.now() - t0;
    this.dirty = true;
    // Reaction impulses back onto rigid bodies
    for (let slot = 0; slot < parts.length; slot++) {
      const o = slot * 6;
      const jx = this.impulses[o], jy = this.impulses[o + 1], jz = this.impulses[o + 2];
      if (jx === 0 && jy === 0 && jz === 0) continue;
      const b = parts[slot].body;
      if (!b.isValid() || !b.isDynamic()) continue;
      // Clamp to a sane velocity change per step to keep light bodies stable.
      const m = b.mass();
      const mag = Math.hypot(jx, jy, jz);
      const max = m * 2.5;
      const s = mag > max ? max / mag : 1;
      b.applyImpulse({ x: jx * s, y: jy * s, z: jz * s }, true);
      b.applyTorqueImpulse({ x: this.impulses[o + 3] * s, y: this.impulses[o + 4] * s, z: this.impulses[o + 5] * s }, true);
    }
  }

  sync(): void {
    const w = this.world;
    const trace = this.traceActive();
    // Rebuilding normals and the water surface is the expensive part: only do
    // it when particles actually moved (not every frame while paused).
    if (!this.dirty && trace === this.lastTrace) return;
    this.dirty = false;
    this.lastTrace = trace;
    for (const r of this.records) if (r.mesh) r.inst.updateVisual(w.pos);
    this.fluid.update(w, trace);
    let ke = 0;
    for (let i = 0; i < w.count; i++) ke += w.vel[i * 3] ** 2 + w.vel[i * 3 + 1] ** 2 + w.vel[i * 3 + 2] ** 2;
    this.lastKinetic = w.count ? ke / w.count : 0;
  }

  // ------------------------------------------------------------------ ParticleTools

  count(): number {
    return this.world.count;
  }

  active(): boolean {
    return this.world.count > 0 && (this.lastKinetic > 1e-4 || this.world.emitters.some((e) => e.remaining > 0));
  }

  grab(soft: SoftInstance, point: THREE.Vector3): number {
    const i = this.world.nearestParticle(point.x, point.y, point.z, soft.start, soft.count);
    if (i < 0) return -1;
    return this.world.grab(i);
  }

  moveGrab(id: number, t: THREE.Vector3): void {
    this.world.moveGrab(id, t.x, t.y, t.z);
  }

  release(id: number): void {
    this.world.release(id);
  }

  explode(c: THREE.Vector3, strength: number, radius: number): void {
    this.world.impulseRadial(c.x, c.y, c.z, strength, radius, false);
  }

  attract(c: THREE.Vector3, strength: number, radius: number, dt: number): void {
    this.world.impulseRadial(c.x, c.y, c.z, strength * 0.4, radius, true, dt);
  }

  pickables(): THREE.Object3D[] {
    return [this.group];
  }

  softFromObject(o: THREE.Object3D, point?: THREE.Vector3): SoftInstance | null {
    let n: THREE.Object3D | null = o;
    while (n) {
      if (n.userData.soft) return n.userData.soft as SoftInstance;
      if (n === this.fluid.group && point) return this.fluidAt(point);
      n = n.parent;
    }
    return null;
  }

  /** The water body nearest to a point on the (shared) fluid surface. */
  private fluidAt(point: THREE.Vector3): SoftInstance | null {
    const w = this.world;
    let best = -1, bd = Infinity;
    for (let i = 0; i < w.count; i++) {
      if (!(w.flags[i] & FLAG_FLUID)) continue;
      const d = (w.pos[i * 3] - point.x) ** 2 + (w.pos[i * 3 + 1] - point.y) ** 2 + (w.pos[i * 3 + 2] - point.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return null;
    const owner = w.owner[best];
    return this.records.find((r) => r.owner === owner)?.inst ?? null;
  }
}

export { PROXY_STRIDE };
