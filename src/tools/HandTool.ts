import * as THREE from 'three';
import { Tool, type HoverInfo, type ToolPointer } from './Tool';
import { icons } from '../ui/icons';
import type { PartInstance } from '../sim/types';
import type { PickResult } from '../app/context';

/**
 * Click to select, drag to grab. The grabbed point is pulled towards the
 * cursor by a critically damped spring force (scaled by mass so light and
 * heavy objects feel the same), plus gravity compensation. Release while
 * moving to throw.
 */
export class HandTool extends Tool {
  readonly id = 'hand';
  readonly label = 'Hand';
  readonly icon = icons.hand;
  readonly key = '1';
  readonly hint = 'Drag an object to grab and throw it · click to inspect · drag empty space to look around';
  override get touchHint(): string {
    return 'Drag things to throw them · tap to inspect · two fingers move the camera';
  }
  readonly description = 'Grab, throw and inspect objects';

  override hover(hit: PickResult | null): HoverInfo {
    if (!hit || hit.isGround) return { cursor: 'default', hint: 'Drag to look around · right-drag to pan · scroll to zoom' };
    if (hit.soft) {
      const kind = hit.soft.def.type;
      if (kind === 'fluid') return { cursor: 'default', hint: 'Water — use Attract or Explode to stir it, Erase to remove it' };
      return { cursor: 'grab', hint: kind === 'cloth' ? 'Drag to pull the cloth' : 'Drag to squish and throw it' };
    }
    if (!hit.part) return { cursor: 'default' };
    if (!hit.part.body.isDynamic()) return { cursor: 'pointer', hint: `${hit.part.entity.name} is pinned in place — click to inspect`, highlight: hit.part };
    return { cursor: 'grab', hint: `Drag to throw the ${hit.part.entity.name.toLowerCase()} · click to inspect`, highlight: hit.part };
  }

  override get activeCursor(): string {
    return 'grabbing';
  }

  private part: PartInstance | null = null;
  private particleGrab = -1;
  private localAnchor = new THREE.Vector3();
  private distance = 0;
  private target = new THREE.Vector3();
  private downAt = { x: 0, y: 0, t: 0 };
  private moved = false;
  private line: THREE.Line;
  private dot: THREE.Mesh;
  private removeForce: (() => void) | null = null;

  constructor(ctx: ConstructorParameters<typeof Tool>[0]) {
    super(ctx);
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x40c4ff, depthTest: false, transparent: true, opacity: 0.9 }));
    this.line.renderOrder = 999;
    this.line.visible = false;
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), new THREE.MeshBasicMaterial({ color: 0x40c4ff, depthTest: false }));
    this.dot.renderOrder = 999;
    this.dot.visible = false;
    ctx.view.helpers.add(this.line, this.dot);
  }

  override onDown(p: ToolPointer): boolean {
    if (p.button !== 0) return false;
    const hit = this.ctx.pick(p.x, p.y);
    this.downAt = { x: p.x, y: p.y, t: performance.now() };
    this.moved = false;
    if (!hit || hit.isGround) {
      this.ctx.select(null);
      return false;
    }
    const cam = this.ctx.view.camera;
    this.distance = hit.point.distanceTo(cam.position);
    this.target.copy(hit.point);

    if (hit.soft && this.ctx.particles) {
      // Water has no single particle to hold: let the click orbit the camera instead.
      const id = hit.soft.def.type === 'fluid' ? -1 : this.ctx.particles.grab(hit.soft, hit.point);
      if (id < 0) return false;
      this.particleGrab = id;
      this.showHelpers(hit.point);
      return true;
    }
    if (!hit.part) return false;
    this.ctx.select(hit.part);
    if (!hit.part.body.isDynamic()) return true;
    this.part = hit.part;
    // Anchor in the body's local frame
    const t = hit.part.body.translation();
    const r = hit.part.body.rotation();
    const inv = new THREE.Quaternion(r.x, r.y, r.z, r.w).invert();
    this.localAnchor.copy(hit.point).sub(new THREE.Vector3(t.x, t.y, t.z)).applyQuaternion(inv);
    hit.part.body.wakeUp();
    this.removeForce?.();
    const fn = (dt: number) => this.applyGrabForce(dt);
    this.ctx.sim.stepForces.push(fn);
    this.removeForce = () => {
      const i = this.ctx.sim.stepForces.indexOf(fn);
      if (i >= 0) this.ctx.sim.stepForces.splice(i, 1);
    };
    this.showHelpers(hit.point);
    return true;
  }

  private showHelpers(p: THREE.Vector3): void {
    this.line.visible = true;
    this.dot.visible = true;
    this.dot.position.copy(p);
  }

  private anchorWorld(out: THREE.Vector3): THREE.Vector3 {
    const b = this.part!.body;
    const t = b.translation();
    const r = b.rotation();
    return out.copy(this.localAnchor).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(t.x, t.y, t.z));
  }

  private applyGrabForce(_dt: number): void {
    const part = this.part;
    if (!part || !part.body.isValid()) return;
    const b = part.body;
    const m = b.mass();
    const strength = this.ctx.settings.data.tools.grabStrength;
    const omega = 2 * Math.PI * 2.2 * Math.sqrt(strength);
    const k = m * omega * omega;
    const c = 2 * m * omega * 0.9;
    const anchor = this.anchorWorld(new THREE.Vector3());
    const v = b.velocityAtPoint({ x: anchor.x, y: anchor.y, z: anchor.z });
    const f = new THREE.Vector3().subVectors(this.target, anchor).multiplyScalar(k).addScaledVector(new THREE.Vector3(v.x, v.y, v.z), -c);
    // Gravity compensation so objects don't sag below the cursor.
    const ph = this.ctx.settings.data.physics;
    if (ph.gravityMode === 'uniform') f.y += m * ph.gravity * part.def.gravityScale;
    const maxF = m * 400 + 2000;
    if (f.length() > maxF) f.setLength(maxF);
    b.addForceAtPoint({ x: f.x, y: f.y, z: f.z }, { x: anchor.x, y: anchor.y, z: anchor.z }, true);
    // Damp spin so a held object settles.
    const w = b.angvel();
    const I = b.principalInertia();
    const d = 6;
    b.addTorque({ x: -w.x * I.x * d, y: -w.y * I.y * d, z: -w.z * I.z * d }, true);
  }

  override onMove(p: ToolPointer): void {
    if (!this.part && this.particleGrab < 0) return;
    // A plain click (to inspect) isn't an edit: only record undo once it drags.
    if (!this.moved && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) > 4) {
      this.moved = true;
      this.ctx.checkpoint('grab', 1500);
    }
    const ray = this.ctx.ray(p.x, p.y);
    this.target.copy(ray.origin).addScaledVector(ray.direction, this.distance);
    if (this.target.y < 0.02) this.target.y = 0.02;
    if (this.particleGrab >= 0) this.ctx.particles?.moveGrab(this.particleGrab, this.target);
  }

  override onWheel(deltaY: number): boolean {
    if (!this.part && this.particleGrab < 0) return false;
    this.distance = Math.max(0.5, this.distance * (1 + deltaY * 0.001));
    return true;
  }

  override onUp(): void {
    this.endGrab();
  }

  private endGrab(): void {
    this.removeForce?.();
    this.removeForce = null;
    this.part = null;
    if (this.particleGrab >= 0) this.ctx.particles?.release(this.particleGrab);
    this.particleGrab = -1;
    this.line.visible = false;
    this.dot.visible = false;
  }

  override update(): void {
    if (!this.line.visible) return;
    const a = this.part ? this.anchorWorld(new THREE.Vector3()) : this.target;
    const pos = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, this.target.x, this.target.y, this.target.z);
    pos.needsUpdate = true;
    this.dot.position.copy(this.target);
  }

  override deactivate(): void {
    this.endGrab();
  }
}
