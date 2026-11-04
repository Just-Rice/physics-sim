import * as THREE from 'three';
import { h, svgIcon } from './dom';
import { icons } from './icons';
import type { PartInstance } from '../sim/types';
import type { PartDef } from '../models/schema';
import { MATERIAL_PRESETS, makeThreeMaterial, resolveMaterial } from '../models/materials';
import { RAPIER } from '../physics/RigidWorld';

export interface InspectorCallbacks {
  onDelete(part: PartInstance): void;
  onDuplicate(part: PartInstance): void;
  onFocus(part: PartInstance): void;
  onClose(): void;
  /** Called once before an edit so it can be undone. */
  onBeforeEdit(): void;
  /** Lets the path tracer know materials changed. */
  onMaterialChanged(): void;
}

/** Live readout and quick edits for the selected rigid part. */
export class Inspector {
  readonly el: HTMLElement;
  private part: PartInstance | null = null;
  private title = h('div', { class: 'insp-title' });
  private sub = h('div', { class: 'insp-sub' });
  private grid = h('div', { class: 'insp-grid' });
  private cells = new Map<string, HTMLElement>();
  private matSel: HTMLSelectElement;
  private swatch = h('span', { class: 'swatch' });
  private friction: HTMLInputElement;
  private restitution: HTMLInputElement;
  private gravityScale: HTMLInputElement;
  private fVal = h('span', { class: 'num' });
  private rVal = h('span', { class: 'num' });
  private gVal = h('span', { class: 'num' });
  private pinBtn: HTMLButtonElement;
  private moreBtn: HTMLButtonElement;
  private lastUpdate = 0;

  constructor(private cb: InspectorCallbacks) {
    this.matSel = h('select', { class: 'select', style: 'flex:1;max-width:none', 'aria-label': 'Material' },
      h('option', { value: '', disabled: true }, '— custom —'),
      ...MATERIAL_PRESETS.filter((m) => m.id !== 'original').map((m) => h('option', { value: m.id }, m.label)));
    this.matSel.addEventListener('change', () => this.applyMaterial(this.matSel.value));
    this.matSel.addEventListener('keydown', (e) => e.stopPropagation());
    const slider = (min: number, max: number, step: number, label: string, on: (v: number) => void) => {
      const s = h('input', { type: 'range', min, max, step, 'aria-label': label });
      s.addEventListener('pointerdown', () => this.cb.onBeforeEdit());
      s.addEventListener('input', () => on(Number(s.value)));
      s.addEventListener('keydown', (e) => e.stopPropagation());
      return s;
    };
    this.friction = slider(0, 1.5, 0.01, 'Friction', (v) => {
      this.setColliders((c) => c.setFriction(v), v, this.fVal);
      this.persist({ friction: v });
    });
    this.restitution = slider(0, 1, 0.01, 'Bounciness', (v) => {
      this.setColliders((c) => c.setRestitution(v), v, this.rVal);
      this.persist({ restitution: v });
    });
    this.gravityScale = slider(-1, 2, 0.05, 'Gravity multiplier', (v) => {
      if (!this.part) return;
      this.part.body.setGravityScale(v, true);
      this.gVal.textContent = v.toFixed(2);
      this.persist({ gravityScale: v });
    });
    this.pinBtn = h('button', { class: 'btn small', title: 'Hold it fixed in space (or let it go again)', onclick: () => this.togglePin() }, svgIcon(icons.pin), h('span', {}, 'Pin in place'));
    for (const k of ['Mass', 'Speed', 'Spin', 'Kinetic energy', 'Height', 'State']) {
      const v = h('div', { class: 'v' });
      this.cells.set(k, v);
      this.grid.append(h('div', { class: 'k' }, k), v);
    }
    // On phones the inspector is a small sheet: name and actions, with the
    // numbers and sliders one tap away (CSS hides this button on desktops).
    this.moreBtn = h('button', { class: 'btn small insp-more', 'aria-expanded': 'false', onclick: () => this.setExpanded(!this.el.classList.contains('expanded')) }, 'More');
    this.el = h('div', { class: 'inspector panel hidden', 'aria-label': 'Selected object' },
      h('div', { class: 'insp-head' }, h('div', { style: 'flex:1;min-width:0' }, this.title, this.sub),
        this.moreBtn,
        h('button', { class: 'icon-btn', style: 'width:28px;height:28px', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => cb.onClose() }, svgIcon(icons.close))),
      this.grid,
      h('div', { class: 'insp-row' }, h('label', {}, 'Material'), this.swatch, this.matSel),
      h('div', { class: 'insp-row', title: 'How grippy the surface is' }, h('label', {}, 'Friction'), this.friction, this.fVal),
      h('div', { class: 'insp-row', title: 'How much energy a bounce keeps' }, h('label', {}, 'Bounciness'), this.restitution, this.rVal),
      h('div', { class: 'insp-row', title: '1 = normal, 0 = floats, negative = falls up' }, h('label', {}, 'Gravity ×'), this.gravityScale, this.gVal),
      h('div', { class: 'insp-actions' },
        this.pinBtn,
        h('button', { class: 'btn small', title: 'Make a copy next to it', onclick: () => this.part && cb.onDuplicate(this.part) }, svgIcon(icons.copy), 'Duplicate'),
        h('button', { class: 'btn small', title: 'Point the camera at it (F)', onclick: () => this.part && cb.onFocus(this.part) }, svgIcon(icons.focus), 'Focus'),
        h('button', { class: 'btn small danger', title: 'Delete (Del)', onclick: () => this.part && cb.onDelete(this.part) }, svgIcon(icons.clear), 'Delete')),
    );
  }

  private setExpanded(on: boolean): void {
    this.el.classList.toggle('expanded', on);
    this.moreBtn.textContent = on ? 'Less' : 'More';
    this.moreBtn.setAttribute('aria-expanded', String(on));
  }

  private setColliders(fn: (c: RAPIER.Collider) => void, v: number, label: HTMLElement): void {
    if (!this.part) return;
    for (const s of this.part.shapes) if (s.collider) fn(s.collider);
    label.textContent = v.toFixed(2);
  }

  /**
   * Keep an edit with the object: the entity gets its own copy of the model
   * so undo, duplicate and "Save scene" all carry the change.
   */
  private persist(patch: Partial<PartDef>): void {
    const p = this.part;
    if (!p) return;
    const e = p.entity;
    if (!e.ownModel) {
      e.model = JSON.parse(JSON.stringify(e.model));
      e.ownModel = true;
      for (const pi of e.parts) pi.def = e.model.parts.find((d) => d.id === pi.def.id) ?? pi.def;
    }
    Object.assign(p.def, patch);
  }

  private applyMaterial(id: string): void {
    const p = this.part;
    if (!p || !id) return;
    this.cb.onBeforeEdit();
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
          if (m.isMesh && !m.userData.overlay) m.material = mat;
        });
      }
    }
    this.persist({ material: id, density: undefined, friction: undefined, restitution: undefined });
    for (const s of p.def.shapes) s.material = undefined;
    p.body.wakeUp();
    this.syncControls();
    this.cb.onMaterialChanged();
  }

  private togglePin(): void {
    const p = this.part;
    if (!p) return;
    this.cb.onBeforeEdit();
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
    this.sub.textContent = `${e.model.category} · ${e.parts.length} part${e.parts.length === 1 ? '' : 's'}${e.joints.length ? ` · ${e.joints.length} joint${e.joints.length === 1 ? '' : 's'}` : ''}`;
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
    const preset = typeof p.def.material === 'string' && MATERIAL_PRESETS.some((m) => m.id === p.def.material && m.id !== 'original')
      ? p.def.material
      : MATERIAL_PRESETS.find((m) => m.id !== 'original' && m.color === p.spec.color && m.density === p.spec.density && m.roughness === p.spec.roughness)?.id;
    this.matSel.value = preset ?? '';
    this.swatch.style.background = p.spec.emissiveIntensity > 0 ? p.spec.emissive : p.spec.color;
    this.swatch.classList.toggle('metal', p.spec.metalness > 0.5);
    this.swatch.classList.toggle('glass', p.spec.transmission > 0.5);
    const pinned = p.body.isFixed();
    this.pinBtn.classList.toggle('active', pinned);
    this.pinBtn.lastChild!.textContent = pinned ? 'Unpin' : 'Pin in place';
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
    const set = (k: string, val: string) => {
      const el = this.cells.get(k)!;
      if (el.textContent !== val) el.textContent = val;
    };
    set('Mass', m >= 1000 ? `${(m / 1000).toFixed(2)} t` : `${m.toFixed(m < 10 ? 2 : 1)} kg`);
    set('Speed', `${speed.toFixed(2)} m/s`);
    set('Spin', `${Math.hypot(w.x, w.y, w.z).toFixed(2)} rad/s`);
    set('Kinetic energy', `${(0.5 * m * speed * speed).toFixed(1)} J`);
    set('Height', `${t.y.toFixed(2)} m`);
    const spin = Math.hypot(w.x, w.y, w.z);
    set('State', b.isFixed() ? 'pinned' : b.isSleeping() || (speed < 0.02 && spin < 0.05) ? 'at rest' : 'moving');
  }
}
