import * as THREE from 'three';
import type { PartInstance } from '../sim/types';
import type { SimPlugin } from '../sim/Simulation';

/** Expanding flash for explosions (helper layer, not path traced). */
export class Flashes {
  private items: { mesh: THREE.Mesh; t: number; r: number }[] = [];
  private geo = new THREE.SphereGeometry(1, 24, 16);

  constructor(private parent: THREE.Object3D) {}

  spawn(p: THREE.Vector3, radius: number, color = 0xffa040): void {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.position.copy(p);
    this.parent.add(mesh);
    this.items.push({ mesh, t: 0, r: radius });
  }

  update(dt: number): void {
    for (const it of [...this.items]) {
      it.t += dt;
      const k = it.t / 0.45;
      it.mesh.scale.setScalar(it.r * (0.2 + k * 0.9));
      (it.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.6 * (1 - k));
      if (k >= 1) {
        it.mesh.removeFromParent();
        (it.mesh.material as THREE.Material).dispose();
        this.items.splice(this.items.indexOf(it), 1);
      }
    }
  }
}

const TRAIL_POINTS = 400;
const PALETTE = [0x40c4ff, 0xff8a3d, 0x3fd68b, 0xff5da2, 0xffd84a, 0xa48bff, 0x5de8e0];

/** Motion trails for moving bodies (helper layer). */
export class Trails implements SimPlugin {
  enabled = false;
  private trails = new Map<PartInstance, { line: THREE.Line; buf: Float32Array; count: number }>();
  private tick = 0;
  private colorIndex = 0;

  constructor(private parent: THREE.Object3D, private parts: () => PartInstance[]) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clear();
  }

  clear(): void {
    for (const t of this.trails.values()) {
      t.line.removeFromParent();
      t.line.geometry.dispose();
    }
    this.trails.clear();
  }

  afterStep(): void {
    if (!this.enabled) return;
    if (++this.tick % 3 !== 0) return;
    const parts = this.parts();
    for (const [p, t] of this.trails) {
      if (!parts.includes(p)) {
        t.line.removeFromParent();
        this.trails.delete(p);
      }
    }
    for (const p of parts) {
      if (!p.body.isDynamic() || p.entity.locked) continue;
      let t = this.trails.get(p);
      if (!t) {
        if (this.trails.size >= 60) continue;
        const v = p.body.linvel();
        if (Math.hypot(v.x, v.y, v.z) < 0.3) continue;
        const buf = new Float32Array(TRAIL_POINTS * 3);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(buf, 3));
        g.setDrawRange(0, 0);
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: PALETTE[this.colorIndex++ % PALETTE.length], transparent: true, opacity: 0.8 }));
        line.frustumCulled = false;
        this.parent.add(line);
        t = { line, buf, count: 0 };
        this.trails.set(p, t);
      }
      const c = p.body.translation();
      if (t.count < TRAIL_POINTS) {
        t.buf.set([c.x, c.y, c.z], t.count * 3);
        t.count++;
      } else {
        t.buf.copyWithin(0, 3);
        t.buf.set([c.x, c.y, c.z], (TRAIL_POINTS - 1) * 3);
      }
      const attr = t.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.needsUpdate = true;
      t.line.geometry.setDrawRange(0, t.count);
    }
  }
}

/** Box outline around the selected part. */
export class SelectionBox {
  readonly helper: THREE.Box3Helper;
  private box = new THREE.Box3();
  part: PartInstance | null = null;

  constructor(parent: THREE.Object3D) {
    this.helper = new THREE.Box3Helper(this.box, 0x40c4ff);
    this.helper.visible = false;
    parent.add(this.helper);
  }

  update(): void {
    if (!this.part || !this.part.body.isValid()) {
      this.helper.visible = false;
      return;
    }
    this.box.setFromObject(this.part.object).expandByScalar(0.01);
    this.helper.visible = !this.box.isEmpty();
  }
}
