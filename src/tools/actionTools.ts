import * as THREE from 'three';
import { Tool, type HoverInfo, type ToolPointer } from './Tool';
import { icons } from '../ui/icons';
import { explode } from '../physics/fields';
import { modelBounds } from '../models/bounds';
import type { PickResult } from '../app/context';

function cameraYaw(camera: THREE.Camera): number {
  const d = new THREE.Vector3();
  camera.getWorldDirection(d);
  const yaw = Math.atan2(-d.x, -d.z) * (180 / Math.PI);
  return Math.round(yaw / 15) * 15;
}

/** Click on the ground or on objects to place the selected library model. */
export class SpawnTool extends Tool {
  readonly id = 'spawn';
  readonly label = 'Place';
  readonly icon = icons.spawn;
  readonly key = '2';
  readonly description = 'Place the model picked in the library';
  get hint(): string {
    const m = this.ctx.library.get(this.modelId);
    return `Click to place “${m?.name ?? this.modelId}” · pick a different model in the library · Shift = drop from higher · Esc = done`;
  }
  modelId = 'crate';
  private ghost: THREE.LineSegments;
  private lastPointer: ToolPointer | null = null;

  constructor(ctx: ConstructorParameters<typeof Tool>[0]) {
    super(ctx);
    this.ghost = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x40c4ff, transparent: true, opacity: 0.8 }),
    );
    this.ghost.visible = false;
    ctx.view.helpers.add(this.ghost);
  }

  private placement(p: ToolPointer, modelId = this.modelId): { pos: THREE.Vector3; yaw: number; size: THREE.Vector3; center: THREE.Vector3 } | null {
    const hit = this.ctx.pick(p.x, p.y);
    if (!hit) return null;
    const model = this.ctx.library.get(modelId);
    if (!model) return null;
    const b = modelBounds(model);
    const size = b.getSize(new THREE.Vector3());
    const yaw = cameraYaw(this.ctx.view.camera);
    const lift = (p.shift ? 2 : 0) + this.ctx.settings.data.tools.spawnHeight * 0.05 + 0.002;
    const pos = hit.point.clone();
    pos.y = hit.point.y - b.min.y + lift;
    // Placing against a wall or the side of an object: step out so it doesn't start inside it.
    if (hit.normal.y < 0.5 && !hit.isGround) pos.addScaledVector(hit.normal, Math.max(size.x, size.z) * 0.5);
    return { pos, yaw, size, center: b.getCenter(new THREE.Vector3()) };
  }

  /** Show the placement outline for `modelId` at a screen point (also used while dragging from the library). */
  previewAt(p: ToolPointer, modelId = this.modelId): void {
    const pl = this.placement(p, modelId);
    if (!pl) {
      this.ghost.visible = false;
      return;
    }
    this.ghost.visible = true;
    this.ghost.scale.copy(pl.size).max(new THREE.Vector3(0.02, 0.02, 0.02));
    this.ghost.rotation.set(0, pl.yaw * (Math.PI / 180), 0);
    this.ghost.position.copy(pl.pos).add(pl.center.applyEuler(this.ghost.rotation));
  }

  hidePreview(): void {
    this.ghost.visible = false;
  }

  /** Place `modelId` at a screen point. */
  placeAt(p: ToolPointer, modelId = this.modelId): boolean {
    const pl = this.placement(p, modelId);
    if (!pl) return false;
    return !!this.ctx.spawnModel(modelId, pl.pos, { yaw: pl.yaw });
  }

  override hover(): HoverInfo {
    return { cursor: 'copy' };
  }

  override get activeCursor(): string {
    return 'copy';
  }

  override onMove(p: ToolPointer): void {
    this.lastPointer = p;
    this.previewAt(p);
  }

  override onDown(p: ToolPointer): boolean {
    if (p.button !== 0) return false;
    return this.placeAt(p);
  }

  override deactivate(): void {
    this.ghost.visible = false;
    this.lastPointer = null;
  }

  override update(): void {
    // The scene moves under a still cursor (things fall, the camera orbits): keep the outline honest.
    if (this.lastPointer && this.ghost.visible) this.previewAt(this.lastPointer);
  }
}

/** Fire projectiles from the camera. Hold to keep firing. */
export class CannonTool extends Tool {
  readonly id = 'cannon';
  readonly label = 'Cannon';
  readonly icon = icons.cannon;
  readonly key = '3';
  readonly description = 'Fire balls (or anything) from the camera';
  get hint(): string {
    const m = this.ctx.library.get(this.ctx.settings.data.tools.cannonModel);
    return `Click to fire a ${m?.name.toLowerCase() ?? 'ball'} · hold for rapid fire · change the projectile in Settings → Quick`;
  }
  private firing = false;
  private pointer: ToolPointer | null = null;
  private cooldown = 0;

  override onDown(p: ToolPointer): boolean {
    if (p.button !== 0) return false;
    this.firing = true;
    this.pointer = p;
    this.cooldown = 0;
    return true;
  }
  override onMove(p: ToolPointer): void {
    this.pointer = p;
  }
  override onUp(): void {
    this.firing = false;
  }

  override update(dt: number): void {
    if (!this.firing || !this.pointer) return;
    this.cooldown -= dt;
    if (this.cooldown > 0) return;
    this.cooldown = 0.16;
    const ray = this.ctx.ray(this.pointer.x, this.pointer.y);
    const start = ray.origin.clone().addScaledVector(ray.direction, 0.8);
    const t = this.ctx.settings.data.tools;
    this.ctx.spawnModel(t.cannonModel, start, { velocity: ray.direction.clone().multiplyScalar(t.cannonSpeed), yaw: 0 });
  }

  override deactivate(): void {
    this.firing = false;
  }
}

/** Radial impulse at the clicked point. */
export class ExplodeTool extends Tool {
  readonly id = 'explode';
  readonly label = 'Explode';
  readonly icon = icons.explode;
  readonly key = '4';
  readonly description = 'Blast everything near the click outwards';
  readonly hint = 'Click to set off an explosion · strength and radius are in Settings → Advanced → Tools';

  override onDown(p: ToolPointer): boolean {
    if (p.button !== 0) return false;
    const hit = this.ctx.pick(p.x, p.y);
    if (!hit) return false;
    this.ctx.checkpoint('explode', 600);
    const t = this.ctx.settings.data.tools;
    const c = hit.point.clone().addScaledVector(hit.normal, 0.15);
    explode(this.ctx.sim.parts, c.x, c.y, c.z, t.explodeStrength, t.explodeRadius);
    this.ctx.particles?.explode(c, t.explodeStrength, t.explodeRadius);
    this.ctx.flash(c, t.explodeRadius * 0.6);
    return true;
  }
}

/** Hold to pull everything nearby towards the cursor. */
export class AttractTool extends Tool {
  readonly id = 'attract';
  readonly label = 'Attract';
  readonly icon = icons.attract;
  readonly key = '5';
  readonly description = 'Hold to pull things towards the cursor (Shift pushes)';
  readonly hint = 'Hold the mouse button to pull things towards the cursor · Shift + hold pushes them away · scroll to reach further';
  private active = false;
  private repel = false;
  private target = new THREE.Vector3();
  private distance = 6;
  private ring: THREE.Mesh;
  private removeForce: (() => void) | null = null;

  constructor(ctx: ConstructorParameters<typeof Tool>[0]) {
    super(ctx);
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.35, 0.015, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.85, depthTest: false }),
    );
    this.ring.renderOrder = 998;
    this.ring.visible = false;
    ctx.view.helpers.add(this.ring);
  }

  override onDown(p: ToolPointer): boolean {
    if (p.button !== 0) return false;
    this.ctx.checkpoint('attract', 1500);
    const hit = this.ctx.pick(p.x, p.y);
    const ray = this.ctx.ray(p.x, p.y);
    this.distance = hit ? Math.min(hit.distance, 25) : 6;
    this.target.copy(ray.origin).addScaledVector(ray.direction, this.distance);
    this.active = true;
    this.repel = p.shift;
    this.ring.visible = true;
    this.removeForce?.();
    const fn = (dt: number) => this.applyForce(dt);
    this.ctx.sim.stepForces.push(fn);
    this.removeForce = () => {
      const i = this.ctx.sim.stepForces.indexOf(fn);
      if (i >= 0) this.ctx.sim.stepForces.splice(i, 1);
    };
    return true;
  }

  override onMove(p: ToolPointer): void {
    if (!this.active) return;
    const ray = this.ctx.ray(p.x, p.y);
    this.target.copy(ray.origin).addScaledVector(ray.direction, this.distance);
  }

  override onWheel(deltaY: number): boolean {
    if (!this.active) return false;
    this.distance = Math.max(1, this.distance * (1 + deltaY * 0.001));
    return true;
  }

  override onUp(): void {
    this.active = false;
    this.ring.visible = false;
    this.removeForce?.();
    this.removeForce = null;
  }

  private applyForce(dt: number): void {
    const s = this.ctx.settings.data.tools.attractStrength * (this.repel ? -1 : 1);
    const radius = 8;
    for (const part of this.ctx.sim.parts) {
      const b = part.body;
      if (!b.isDynamic()) continue;
      const c = b.worldCom();
      const dx = this.target.x - c.x, dy = this.target.y - c.y, dz = this.target.z - c.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > radius || d < 1e-3) continue;
      const m = b.mass();
      const fall = 1 - d / radius;
      const mag = (s * m * fall) / Math.max(d, 0.6);
      const v = b.linvel();
      // Damping keeps things from orbiting the cursor forever.
      const damp = this.repel ? 0 : 2.5 * m * fall;
      b.addForce({ x: (dx / d) * mag - v.x * damp, y: (dy / d) * mag - v.y * damp, z: (dz / d) * mag - v.z * damp }, true);
    }
    this.ctx.particles?.attract(this.target, s, radius, dt);
  }

  override update(): void {
    if (!this.ring.visible) return;
    this.ring.position.copy(this.target);
    this.ring.quaternion.copy(this.ctx.view.camera.quaternion);
    const k = 1 + 0.15 * Math.sin(performance.now() * 0.012);
    this.ring.scale.setScalar(k);
  }

  override deactivate(): void {
    this.onUp();
  }
}

/** Click to delete an object. */
export class EraseTool extends Tool {
  readonly id = 'erase';
  readonly label = 'Erase';
  readonly icon = icons.erase;
  readonly key = '6';
  readonly description = 'Click something to delete it (Ctrl/⌘ + Z brings it back)';
  readonly hint = 'Click an object to delete it · Ctrl/⌘ + Z to undo';

  override hover(hit: PickResult | null): HoverInfo {
    const entity = hit?.part?.entity ?? hit?.soft?.entity;
    if (!entity || entity.locked) return { cursor: 'not-allowed', hint: 'Nothing to erase here' };
    return { cursor: 'pointer', hint: `Click to delete the ${entity.name.toLowerCase()}`, highlight: hit?.part ?? null, highlightColor: 0xff5d5d };
  }

  override get activeCursor(): string {
    return 'pointer';
  }

  override onDown(p: ToolPointer): boolean {
    if (p.button !== 0) return false;
    const hit = this.ctx.pick(p.x, p.y);
    if (!hit) return false;
    const entity = hit.part?.entity ?? hit.soft?.entity;
    if (!entity || entity.locked) return false;
    this.ctx.deleteEntity(entity);
    return true;
  }
}
