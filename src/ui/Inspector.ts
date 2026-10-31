import * as THREE from 'three';
import { h, svgIcon } from './dom';
import { icons } from './icons';
import type { PartInstance } from '../sim/types';
import { MATERIAL_PRESETS, makeThreeMaterial, resolveMaterial } from '../models/materials';
import { RAPIER } from '../physics/RigidWorld';

export interface InspectorCallbacks {
  onDelete(part: PartInstance): void;
  onFocus(part: PartInstance): void;
  onClose(): void;
}

/** Live readout and quick edits for the selected rigid part. */
export class Inspector {
  readonly el: HTMLElement;
  private part: PartInstance | null = null;
  private title = h('div', { class: 'insp-title' });
  private sub = h('div', { class: 'insp-sub' });
  private grid = h('div', { class: 'insp-grid' });
  private matSel: HTMLSelectElement;
  private friction: HTMLInputElement;
  private restitution: HTMLInputElement;
  private gravityScale: HTMLInputElement;
  private fVal = h('span', { class: 'num' });
  private rVal = h('span', { class: 'num' });
  private gVal = h('span', { class: 'num' });
  private pinBtn: HTMLButtonElement;
  private lastUpdate = 0;

  constructor(private cb: InspectorCallbacks) {
    this.matSel = h('select', { class: 'select', style: 'flex:1;max-width:none' },
      ...MATERIAL_PRESETS.filter((m) => m.id !== 'original').map((m) => h('option', { value: m.id }, m.label)));
    this.matSel.addEventListener('change', () => this.applyMaterial(this.matSel.value));
    const slider = (min: number, max: number, step: number, on: (v: number) => void) => {
      const s = h('input', { type: 'range', min, max, step });
      s.addEventListener('input', () => on(Number(s.value)));
      s.addEventListener('keydown', (e) => e.stopPropagation());
      return s;
    };
    this.friction = slider(0, 1.5, 0.01, (v) => this.setColliders((c) => c.setFriction(v), v, this.fVal));
    this.restitution = slider(0, 1, 0.01, (v) => this.setColliders((c) => c.setRestitution(v), v, this.rVal));
    this.gravityScale = slider(-1, 2, 0.05, (v) => {
      if (!this.part) return;
      this.part.body.setGravityScale(v, true);
      this.gVal.textContent = v.toFixed(2);
    });
    this.pinBtn = h('button', { class: 'btn small', onclick: () => this.togglePin() }, svgIcon(icons.pin), 'Pin');
    this.el = h('div', { class: 'inspector panel hidden' },
      h('div', { class: 'insp-head' }, h('div', {}, this.title, this.sub),
        h('button', { class: 'icon-btn', style: 'width:28px;height:28px', title: 'Close', onclick: () => cb.onClose() }, svgIcon(icons.close))),
      this.grid,
      h('div', { class: 'insp-row' }, h('label', {}, 'Material'), this.matSel),
      h('div', { class: 'insp-row' }, h('label', {}, 'Friction'), this.friction, this.fVal),
      h('div', { class: 'insp-row' }, h('label', {}, 'Bounciness'), this.restitution, this.rVal),
      h('div', { class: 'insp-row' }, h('label', {}, 'Gravity ×'), this.gravityScale, this.gVal),
      h('div', { class: 'insp-actions' },
        this.pinBtn,
        h('button', { class: 'btn small', onclick: () => this.part && cb.onFocus(this.part) }, svgIcon(icons.focus), 'Focus'),
        h('button', { class: 'btn small danger', onclick: () => this.part && cb.onDelete(this.part) }, svgIcon(icons.clear), 'Delete')),
    );
  }

  private setColliders(fn: (c: RAPIER.Collider) => void, v: number, label: HTMLElement): void {
    if (!this.part) return;
    for (const s of this.part.shapes) if (s.collider) fn(s.collider);
    label.textContent = v.toFixed(2);
  }

  private applyMaterial(id: string): void {
    const p = this.part;
    if (!p) return;
    const spec = resolveMaterial(id);
    p.spec = spec;
    for (const s of p.shapes) {
      s.spec = spec;
      if (s.collider) {
        s.collider.setDensity(spec.density);
        s.collider.setFriction(spec.friction);
        s.collider.setRestitution(spec.restitution);
      }
      if (s.visual) {
        const mat = makeThreeMaterial(spec);
        s.visual.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.material = mat;
        });
      }
    }
    p.body.wakeUp();
    this.syncControls();
    this.onMaterialChanged?.();
  }

  /** Lets the path tracer know materials changed. */
  onMaterialChanged?: () => void;

  private togglePin(): void {
    const p = this.part;
    if (!p) return;
    const fixed = p.body.isFixed();
    p.body.setBodyType(fixed ? RAPIER.RigidBodyType.Dynamic : RAPIER.RigidBodyType.Fixed, true);
    if (fixed) p.body.wakeUp();
    else {
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    }
    this.syncControls();
  }

  show(part: PartInstance | null): void {
    this.part = part;
    this.el.classList.toggle('hidden', !part);
    if (!part) return;
    const e = part.entity;
    this.title.textContent = e.parts.length > 1 ? `${e.name} · ${part.def.name}` : e.name;
    this.sub.textContent = `${e.model.category} · ${e.parts.length} part${e.parts.length === 1 ? '' : 's'}${e.joints.length ? ` · ${e.joints.length} joints` : ''}`;
    this.syncControls();
    this.update(true);
  }

  get current(): PartInstance | null {
    return this.part;
  }

  private syncControls(): void {
    const p = this.part;
    if (!p) return;
    const c = p.shapes.find((s) => s.collider)?.collider;
    const f = c?.friction() ?? p.spec.friction;
    const r = c?.restitution() ?? p.spec.restitution;
    this.friction.value = String(f);
    this.restitution.value = String(r);
    this.fVal.textContent = f.toFixed(2);
    this.rVal.textContent = r.toFixed(2);
    const g = p.body.gravityScale();
    this.gravityScale.value = String(g);
    this.gVal.textContent = g.toFixed(2);
    const preset = MATERIAL_PRESETS.find((m) => m.color === p.spec.color && m.density === p.spec.density && m.roughness === p.spec.roughness);
    this.matSel.value = preset?.id ?? '';
    this.pinBtn.classList.toggle('active', p.body.isFixed());
    this.pinBtn.lastChild!.textContent = p.body.isFixed() ? 'Unpin' : 'Pin';
  }

  update(force = false): void {
    const p = this.part;
    if (!p) return;
    if (!p.body.isValid()) {
      this.cb.onClose();
      return;
    }
    const now = performance.now();
    if (!force && now - this.lastUpdate < 150) return;
    this.lastUpdate = now;
    const b = p.body;
    const m = b.isDynamic() ? b.mass() : p.shapes.reduce((a, s) => a + (s.collider?.mass() ?? 0), 0);
    const v = b.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    const w = b.angvel();
    const t = b.translation();
    const rows: [string, string][] = [
      ['Mass', m >= 1000 ? `${(m / 1000).toFixed(2)} t` : `${m.toFixed(m < 10 ? 2 : 1)} kg`],
      ['Speed', `${speed.toFixed(2)} m/s`],
      ['Spin', `${Math.hypot(w.x, w.y, w.z).toFixed(2)} rad/s`],
      ['Kinetic E', `${(0.5 * m * speed * speed).toFixed(1)} J`],
      ['Momentum', `${(m * speed).toFixed(1)} kg·m/s`],
      ['Height', `${t.y.toFixed(2)} m`],
      ['State', b.isFixed() ? 'pinned' : b.isSleeping() ? 'sleeping' : 'awake'],
    ];
    this.grid.replaceChildren(...rows.flatMap(([k, val]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, val)]));
  }
}
