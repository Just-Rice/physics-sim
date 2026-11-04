import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { App } from '../app/App';
import { parseModel, type JointDef, type ModelDef, type PartDef, type ShapeDef, type SoftPartDef } from '../models/schema';
import { MATERIAL_PRESETS, makeThreeMaterial, resolveMaterial } from '../models/materials';
import { degFromQuat, primitiveGeometry, quatFromDeg } from '../models/geometry';
import { allAssets, cloneAssetNode } from '../models/assets';
import { exportModelGLB, exportModelJSON } from '../models/export/exportModel';
import { serializeScene, type SavedScene } from '../scenes/sceneIO';
import { confirmDialog, h, isTouch, modal, prefs, svgIcon } from '../ui/dom';
import { icons } from '../ui/icons';

type Sel = { kind: 'part'; id: string } | { kind: 'joint'; index: number } | { kind: 'soft'; id: string };
type V3 = [number, number, number];

const JOINT_TYPES = ['hinge', 'ball', 'fixed', 'slider', 'spring', 'rope'] as const;
type JointType = (typeof JOINT_TYPES)[number];

const JOINT_INFO: Record<JointType, { label: string; tip: string }> = {
  hinge: { label: 'Hinge', tip: 'Swings around one axis — wheels, doors, pendulums' },
  ball: { label: 'Ball', tip: 'Swivels in every direction — ragdoll shoulders, chains' },
  fixed: { label: 'Glue', tip: 'Locks two parts together rigidly' },
  slider: { label: 'Slider', tip: 'Slides along one axis — pistons, drawers' },
  spring: { label: 'Spring', tip: 'Bouncy, stretchy connection' },
  rope: { label: 'Rope', tip: 'Holds parts within a maximum distance' },
};

// Shared by every joint marker (rebuild() runs on each edit).
const JOINT_DOT_GEO = new THREE.SphereGeometry(0.05, 16, 12);
const JOINT_DOT_MAT = new THREE.MeshBasicMaterial({ color: 0xff8a3d, depthTest: false });
const HIDDEN_SHAPE_MAT = new THREE.MeshBasicMaterial({ color: 0x40c4ff, wireframe: true });
const WATER_PREVIEW_MAT = new THREE.MeshPhysicalMaterial({ color: '#3d9be0', transparent: true, opacity: 0.55, roughness: 0.1 });

/** Free what rebuild() allocated for an object it is throwing away. */
function disposeOwned(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.ArrowHelper) {
      // Its geometry is shared by every arrow; the materials are its own.
      (o.line.material as THREE.Material).dispose();
      (o.cone.material as THREE.Material).dispose();
    }
    if (o.userData.ownGeo) (o as THREE.Mesh).geometry.dispose();
    if (o.userData.ownMat) ((o as THREE.Mesh).material as THREE.Material).dispose();
  });
}

/** "click" or "tap", whichever the person is using. */
const CLICK = isTouch() ? 'tap' : 'click';

const SNAP_MOVE = 0.05;
const SNAP_TURN = THREE.MathUtils.degToRad(15);
const SNAP_SCALE = 0.1;

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function emptyModel(): ModelDef {
  return parseModel({ id: 'draft', name: 'My model', category: 'My Models', parts: [], joints: [], softParts: [] });
}

/**
 * Model Builder: assemble parts from primitives and meshes, give them
 * materials, connect them with joints and motors, add cloth/soft/fluid parts,
 * test-drop the result, then save it to the library or export it.
 */
export class Builder {
  readonly el: HTMLElement[];
  private draft: ModelDef = emptyModel();
  private root = new THREE.Group();
  private tc: TransformControls;
  private sel: Sel | null = null;
  private multi = new Set<string>();
  private objects = new Map<string, THREE.Object3D>();
  private selBox: THREE.BoxHelper;
  private history: string[] = [];
  private future: string[] = [];
  private active = false;
  private testing = false;
  private stash: SavedScene | null = null;
  private panel: HTMLElement;
  private bar: HTMLElement;
  private list: HTMLElement;
  private props: HTMLElement;
  private nameInput: HTMLInputElement;
  private testBtn: HTMLButtonElement;
  private down = { x: 0, y: 0 };
  private dragging = false;
  private gizmoBtns: Record<'translate' | 'rotate' | 'scale', HTMLButtonElement>;
  private snapBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private snap = prefs.get('builder-snap') !== '0';
  /** Guided joint creation: which joint, and the first part once picked. */
  private jointMode: { type: JointType; a: string | null } | null = null;
  private jointBtns = new Map<JointType, HTMLButtonElement>();
  private banner: HTMLElement;
  private bannerText: HTMLElement;
  private checklist: HTMLElement;
  private progress = { moved: false, tested: false, saved: false };

  constructor(private app: App) {
    this.root.name = 'builder';
    this.root.visible = false;
    app.view.scene.add(this.root);
    this.tc = new TransformControls(app.view.camera, app.view.renderer.domElement);
    // Fingers need bigger arrows to grab.
    this.tc.setSize(isTouch() ? 1.3 : 0.9);
    const helper = this.tc.getHelper();
    app.view.helpers.add(helper);
    this.tc.addEventListener('dragging-changed', (e) => {
      const d = (e as unknown as { value: boolean }).value;
      app.view.controls.enabled = !d;
      if (d) {
        this.dragging = true;
        this.pushHistory();
      } else {
        this.commitTransform(true);
        setTimeout(() => (this.dragging = false), 0);
      }
    });
    this.tc.addEventListener('objectChange', () => this.commitTransform(false));
    this.selBox = new THREE.BoxHelper(new THREE.Object3D(), 0x40c4ff);
    this.selBox.visible = false;
    app.view.helpers.add(this.selBox);

    this.list = h('div', { class: 'bp-list' });
    this.props = h('div', { class: 'bp-props' });
    const prim = (label: string, fn: () => void) => h('button', { onclick: fn }, label);
    const meshSelect = h('select', { class: 'select', style: 'width:100%;max-width:none;margin-top:6px' }) as HTMLSelectElement;
    meshSelect.addEventListener('focus', () => this.fillMeshSelect(meshSelect));
    meshSelect.addEventListener('change', () => {
      if (meshSelect.value) this.addShapePart({ type: 'mesh', asset: meshSelect.value } as ShapeDef);
      meshSelect.value = '';
    });
    this.fillMeshSelect(meshSelect);

    this.panel = h('div', { class: 'builder-panel panel hidden' },
      h('div', { class: 'bp-section' }, h('h4', {}, 'Add shape'),
        h('div', { class: 'bp-prims' },
          prim('Box', () => this.addShapePart({ type: 'box', size: [0.5, 0.5, 0.5] } as ShapeDef)),
          prim('Sphere', () => this.addShapePart({ type: 'sphere', radius: 0.25 } as ShapeDef)),
          prim('Cylinder', () => this.addShapePart({ type: 'cylinder', radius: 0.2, height: 0.5 } as ShapeDef)),
          prim('Capsule', () => this.addShapePart({ type: 'capsule', radius: 0.15, height: 0.6 } as ShapeDef)),
          prim('Cone', () => this.addShapePart({ type: 'cone', radius: 0.25, height: 0.5 } as ShapeDef)),
          prim('Plank', () => this.addShapePart({ type: 'box', size: [1.5, 0.06, 0.3] } as ShapeDef)),
        ),
        meshSelect),
      h('div', { class: 'bp-section' }, h('h4', {}, 'Add soft part'),
        h('div', { class: 'bp-prims' },
          prim('Cloth', () => this.addSoft('cloth')),
          prim('Jelly', () => this.addSoft('softbody')),
          prim('Water', () => this.addSoft('fluid')),
        )),
      h('div', { class: 'bp-section' }, h('h4', {}, 'Connect parts'),
        h('div', { class: 'bp-prims' }, ...JOINT_TYPES.map((t) => {
          const b = h('button', { title: JOINT_INFO[t].tip, onclick: () => this.startJoint(t) }, JOINT_INFO[t].label);
          this.jointBtns.set(t, b);
          return b;
        })),
        h('div', { class: 'insp-sub', style: 'margin-top:6px' }, `Pick a joint, then ${CLICK} two parts — or one part and empty space to pin it to the world.`)),
      this.checklist = h('div', { class: 'bp-section bp-checklist' }),
      this.list,
      this.props,
    );

    this.nameInput = h('input', { type: 'text', value: 'My model', title: 'Model name' });
    this.nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    this.nameInput.addEventListener('change', () => (this.draft.name = this.nameInput.value || 'My model'));
    this.testBtn = h('button', { class: 'btn primary', title: 'Drop it into the world and play with it', onclick: () => (this.testing ? this.stopTest() : this.startTest()) }, svgIcon(icons.play), 'Test');
    const gizmo = (mode: 'translate' | 'rotate' | 'scale', icon: string, label: string, key: string) =>
      h('button', { class: 'seg-btn', title: `${label} the selected part (${key})`, 'aria-label': label, onclick: () => this.setGizmo(mode) }, svgIcon(icon), h('span', { class: 'txt' }, label));
    this.gizmoBtns = {
      translate: gizmo('translate', icons.move, 'Move', 'W'),
      rotate: gizmo('rotate', icons.rotate, 'Turn', 'E'),
      scale: gizmo('scale', icons.scale, 'Resize', 'R'),
    };
    this.snapBtn = h('button', { class: 'seg-btn', title: 'Snap to 5 cm steps and 15° turns (hold Shift to toggle while dragging)', 'aria-label': 'Snap', onclick: () => this.setSnap(!this.snap) }, svgIcon(icons.magnet), h('span', { class: 'txt' }, 'Snap'));
    this.undoBtn = h('button', { class: 'seg-btn', title: 'Undo (Ctrl/⌘ Z)', 'aria-label': 'Undo', onclick: () => this.undo() }, svgIcon(icons.undo));
    this.redoBtn = h('button', { class: 'seg-btn', title: 'Redo (Ctrl/⌘ ⇧ Z)', 'aria-label': 'Redo', onclick: () => this.redo() }, svgIcon(icons.redo));
    this.bar = h('div', { class: 'builder-bar panel hidden' },
      this.nameInput,
      h('div', { class: 'seg' }, this.undoBtn, this.redoBtn),
      h('div', { class: 'seg' }, this.gizmoBtns.translate, this.gizmoBtns.rotate, this.gizmoBtns.scale),
      h('div', { class: 'seg' }, this.snapBtn),
      this.testBtn,
      h('button', { class: 'btn', onclick: () => this.save(), title: 'Save to My Models in the library' }, svgIcon(icons.save), 'Save'),
      h('button', { class: 'btn', onclick: () => this.exportMenu(), title: 'Download as a file' }, svgIcon(icons.download), 'Export'),
      h('button', { class: 'btn', onclick: () => this.newModel(), title: 'Start a new model' }, 'New'),
      h('button', { class: 'btn', onclick: () => app.setMode('play'), title: 'Back to Play (Esc)' }, 'Done'),
    );
    this.bannerText = h('span', {});
    this.banner = h('div', { class: 'builder-banner panel hidden', role: 'status' },
      this.bannerText,
      h('button', { class: 'btn small', onclick: () => this.cancelJoint() }, 'Cancel'));
    this.el = [this.panel, this.bar, this.banner];
    this.setGizmo('translate');
    this.setSnap(this.snap);
    this.syncUndo();

    const dom = app.view.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => {
      if (!this.active || this.testing) return;
      this.down = { x: e.clientX, y: e.clientY };
    });
    dom.addEventListener('pointerup', (e) => {
      if (!this.active || this.testing || this.dragging || e.button !== 0) return;
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) return;
      if (this.jointMode) this.jointPick(e.clientX, e.clientY);
      else this.pickAt(e.clientX, e.clientY, e.shiftKey);
    });
    // Holding Shift flips snapping for the current drag.
    const shiftSnap = (e: KeyboardEvent) => {
      if (e.key === 'Shift' && this.active) this.applySnap(e.type === 'keydown' ? !this.snap : this.snap);
    };
    window.addEventListener('keydown', shiftSnap);
    window.addEventListener('keyup', shiftSnap);
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  // ------------------------------------------------------------------ mode

  enter(model?: ModelDef): void {
    if (!this.active) {
      this.active = true;
      // The builder owns the simulation while it is open; stash the play scene.
      this.stash = serializeScene(this.app.sim, this.app.library, this.app.settings.data, this.app.view.camera, this.app.view.controls.target, this.app.view.ground.visible);
      this.app.sim.clear();
      this.app.particles?.reset();
      this.app.view.ground.visible = true;
      this.app.sim.setGroundEnabled(true);
      this.panel.classList.remove('hidden');
      this.bar.classList.remove('hidden');
      this.root.visible = true;
      this.app.view.camera.position.set(3.5, 2.5, 4.5);
      this.app.view.controls.target.set(0, 0.6, 0);
      this.app.view.controls.update();
    }
    if (model) {
      const copy = parseModel(JSON.parse(JSON.stringify(model)));
      if (!copy.id.startsWith('user-')) {
        copy.id = 'draft';
        copy.name = `${copy.name} (copy)`;
      }
      copy.category = 'My Models';
      this.draft = copy;
      this.history = [];
      this.future = [];
      this.progress = { moved: false, tested: false, saved: false };
    }
    this.syncUndo();
    this.nameInput.value = this.draft.name;
    this.select(null);
    this.rebuild();
  }

  exit(): void {
    if (!this.active) return;
    if (this.testing) this.stopTest();
    this.cancelJoint();
    this.active = false;
    this.tc.detach();
    this.selBox.visible = false;
    this.root.visible = false;
    this.panel.classList.add('hidden');
    this.bar.classList.add('hidden');
    this.banner.classList.add('hidden');
    if (this.stash) this.app.applySavedScene(this.stash, true);
    this.stash = null;
  }

  update(dt: number): void {
    if (this.testing) {
      this.app.simulateFrame(dt);
      return;
    }
    if (this.sel) {
      const o = this.objectFor(this.sel);
      if (o) {
        this.selBox.setFromObject(o);
        this.selBox.visible = true;
      }
    } else this.selBox.visible = false;
  }

  // ------------------------------------------------------------------ test run

  private startTest(): void {
    if (!this.draft.parts.length && !this.draft.softParts.length) {
      this.app.toast('Add some shapes first', 'error');
      return;
    }
    this.cancelJoint();
    this.testing = true;
    this.progress.tested = true;
    this.tc.detach();
    this.selBox.visible = false;
    this.root.visible = false;
    this.panel.classList.add('hidden');
    this.app.sim.root.visible = true;
    this.app.particles?.pickables().forEach((o) => (o.visible = true));
    this.app.tools.enabled = true;
    this.app.settings.set('physics', 'paused', false);
    this.app.sim.spawn(this.draft, { model: this.draft.id, position: [0, 0, 0], rotation: [0, 0, 0] });
    this.app.sim.sync(1);
    this.app.pt?.markSceneDirty();
    this.testBtn.replaceChildren(svgIcon(icons.pause), 'Stop');
    this.app.setBuilderTesting(true);
    this.app.toast('Testing — grab it, throw it, blow it up. Stop (or Esc) to keep editing.');
  }

  stopTest(): void {
    if (!this.testing) return;
    this.testing = false;
    this.app.setBuilderTesting(false);
    this.app.sim.clear();
    this.app.particles?.reset();
    this.app.sim.root.visible = false;
    this.app.tools.enabled = false;
    this.root.visible = true;
    this.panel.classList.remove('hidden');
    this.testBtn.replaceChildren(svgIcon(icons.play), 'Test');
    this.app.pt?.markSceneDirty();
    this.select(this.sel);
  }

  // ------------------------------------------------------------------ history

  private pushHistory(): void {
    this.history.push(JSON.stringify(this.draft));
    if (this.history.length > 60) this.history.shift();
    this.future = [];
    this.syncUndo();
  }

  private syncUndo(): void {
    this.undoBtn.disabled = !this.history.length;
    this.redoBtn.disabled = !this.future.length;
  }

  private undo(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(JSON.stringify(this.draft));
    this.draft = parseModel(JSON.parse(prev));
    this.sel = null;
    this.rebuild();
    this.syncUndo();
  }

  private redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(JSON.stringify(this.draft));
    this.draft = parseModel(JSON.parse(next));
    this.sel = null;
    this.rebuild();
    this.syncUndo();
  }

  private change(fn: () => void): void {
    this.pushHistory();
    fn();
    this.draft = parseModel(this.draft); // apply schema defaults to new data
    this.rebuild();
  }

  // ------------------------------------------------------------------ editing ops

  /** World-space boxes of everything in the draft (to keep new things from overlapping). */
  private occupied(): THREE.Box3[] {
    this.root.updateMatrixWorld(true);
    const out: THREE.Box3[] = [];
    for (const [k, o] of this.objects) if (!k.startsWith('joint:')) out.push(new THREE.Box3().setFromObject(o));
    return out;
  }

  /**
   * Where a new thing of this size should go: on top of the selected part, or
   * on the ground near the camera target in the first free spot.
   * `size` is the full extent; returns the centre.
   */
  private placeFor(size: THREE.Vector3): V3 {
    const boxes = this.occupied();
    const sel = this.sel && this.sel.kind !== 'joint' ? this.objectFor(this.sel) : undefined;
    if (sel) {
      const b = new THREE.Box3().setFromObject(sel);
      const c = b.getCenter(new THREE.Vector3());
      // Stack upward until clear (something may already sit on it).
      let y = b.max.y + size.y / 2 + 0.002;
      for (let i = 0; i < 20; i++) {
        const cand = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(c.x, y, c.z), size).expandByScalar(-0.001);
        const hit = boxes.find((o) => o.intersectsBox(cand));
        if (!hit) break;
        y = hit.max.y + size.y / 2 + 0.002;
      }
      return [round(c.x), round(y), round(c.z)];
    }
    const t = this.app.view.controls.target;
    const y = size.y / 2 + 0.002;
    const step = Math.max(size.x, size.z) + 0.1;
    for (let ring = 0; ring < 12; ring++) {
      const n = ring === 0 ? 1 : ring * 8;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const x = t.x + Math.cos(a) * ring * step;
        const z = t.z + Math.sin(a) * ring * step;
        const cand = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(x, y, z), size).expandByScalar(0.02);
        if (!boxes.some((o) => o.intersectsBox(cand))) return [round(x), round(y), round(z)];
      }
    }
    return [round(t.x), round(y), round(t.z)];
  }

  private shapeSize(s: ShapeDef): THREE.Vector3 {
    if (s.type === 'mesh') {
      const o = cloneAssetNode(s.asset, s.node);
      if (!o) return new THREE.Vector3(0.5, 0.5, 0.5);
      o.scale.set(...s.scale);
      return new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    }
    const g = primitiveGeometry(s);
    if (!g.boundingBox) g.computeBoundingBox();
    return g.boundingBox!.getSize(new THREE.Vector3());
  }

  private nextId(prefix: string): string {
    const used = new Set([...this.draft.parts.map((p) => p.id), ...this.draft.softParts.map((s) => s.id)]);
    let i = 1;
    while (used.has(`${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  }

  private addShapePart(shape: ShapeDef): void {
    const s = parseModel({ id: 'x', name: 'x', parts: [{ id: 'x', shapes: [shape] }] }).parts[0].shapes[0];
    const id = this.nextId('part');
    const position = this.placeFor(this.shapeSize(s));
    this.change(() => {
      this.draft.parts.push({ ...parseModel({ id: 'x', name: 'x', parts: [{ id, name: `${s.type[0].toUpperCase()}${s.type.slice(1)} ${id.slice(4)}`, shapes: [s], material: s.type === 'mesh' ? 'plastic-white' : 'plastic' }] }).parts[0], position });
    });
    this.select({ kind: 'part', id });
  }

  private addSoft(type: SoftPartDef['type']): void {
    const id = this.nextId(type === 'softbody' ? 'jelly' : type);
    let def: unknown;
    if (type === 'cloth') {
      // Cloth hangs from its top edge: give it room above the ground.
      const p = this.placeFor(new THREE.Vector3(1.2, 1.2, 0.05));
      def = { id, type, position: [p[0], Math.max(p[1], 1.6), p[2]], size: [1.2, 1.2], resolution: [20, 20], pins: 'top-edge' };
    } else if (type === 'softbody') {
      def = { id, type, shape: 'sphere', size: [0.3, 0.3, 0.3], position: this.placeFor(new THREE.Vector3(0.6, 0.6, 0.6)) };
    } else {
      def = { id, type, size: [0.5, 0.5, 0.5], position: this.placeFor(new THREE.Vector3(0.5, 0.5, 0.5)) };
    }
    this.change(() => this.draft.softParts.push(def as SoftPartDef));
    this.select({ kind: 'soft', id });
  }

  // ------------------------------------------------------------------ guided joints

  /** Pick a joint type: then click part A, then part B (or empty space for the world). */
  private startJoint(type: JointType): void {
    if (!this.draft.parts.length) {
      this.app.toast('Add a shape first — joints connect parts', 'error');
      return;
    }
    // Two parts already selected: connect them straight away.
    const ids = [...this.multi];
    if (this.sel?.kind === 'part' && !ids.includes(this.sel.id)) ids.unshift(this.sel.id);
    if (ids.length >= 2) {
      this.createJoint(type, ids[0], ids[1]);
      return;
    }
    this.jointMode = { type, a: this.sel?.kind === 'part' ? this.sel.id : null };
    this.tc.detach();
    this.syncJointUi();
  }

  private cancelJoint(): void {
    if (!this.jointMode) return;
    this.jointMode = null;
    this.syncJointUi();
    this.select(this.sel);
  }

  private syncJointUi(): void {
    const jm = this.jointMode;
    for (const [t, b] of this.jointBtns) b.classList.toggle('active', jm?.type === t);
    this.banner.classList.toggle('hidden', !jm);
    this.app.view.renderer.domElement.style.cursor = jm ? 'crosshair' : '';
    if (!jm) return;
    const label = JOINT_INFO[jm.type].label;
    const a = jm.a ? this.draft.parts.find((p) => p.id === jm.a)?.name : null;
    this.bannerText.textContent = a
      ? `${label}: now ${CLICK} the part to connect “${a}” to — or empty space to pin it to the world`
      : `${label}: ${CLICK} the first part`;
  }

  private jointPick(x: number, y: number): void {
    const jm = this.jointMode!;
    const hit = this.hitSel(x, y);
    if (hit && hit.kind !== 'part') {
      this.app.toast(`Joints connect solid parts — ${CLICK} a shape`, 'error');
      return;
    }
    if (!jm.a) {
      if (!hit) return;
      jm.a = hit.id;
      this.sel = hit;
      this.renderList();
      this.syncJointUi();
      return;
    }
    if (hit && hit.id === jm.a) return;
    this.createJoint(jm.type, jm.a, hit ? hit.id : null);
  }

  private createJoint(type: JointDef['type'], aId: string, bId: string | null): void {
    this.jointMode = null;
    this.syncJointUi();
    const a = this.draft.parts.find((p) => p.id === aId)!;
    const b = bId ? this.draft.parts.find((p) => p.id === bId) ?? null : null;
    const pa = new THREE.Vector3(...a.position);
    const anchor = b ? pa.clone().add(new THREE.Vector3(...b.position)).multiplyScalar(0.5) : pa.clone().add(new THREE.Vector3(0, 0.3, 0));
    const j: JointDef = parseModel({ id: 'x', name: 'x', parts: [{ id: 'a', shapes: [{ type: 'sphere', radius: 1 }] }], joints: [{ type, a: a.id, b: b ? b.id : null, anchor: [round(anchor.x), round(anchor.y), round(anchor.z)] }] }).joints[0];
    if (type === 'spring' || type === 'rope') {
      j.anchor = [...a.position] as V3;
      j.anchorB = b ? ([...b.position] as V3) : [a.position[0], a.position[1] + 1, a.position[2]];
    }
    this.change(() => this.draft.joints.push(j));
    this.multi.clear();
    this.select({ kind: 'joint', index: this.draft.joints.length - 1 });
    this.app.toast(`${JOINT_INFO[type as JointType].label} added — drag the orange dot to move where it pivots`);
  }

  private deleteSelected(): void {
    const s = this.sel;
    if (!s) return;
    this.change(() => {
      if (s.kind === 'part') {
        this.draft.parts = this.draft.parts.filter((p) => p.id !== s.id);
        this.draft.joints = this.draft.joints.filter((j) => j.a !== s.id && j.b !== s.id);
        for (const sp of this.draft.softParts) if (sp.type === 'cloth' && sp.attachTo === s.id) sp.attachTo = null;
      } else if (s.kind === 'joint') this.draft.joints.splice(s.index, 1);
      else this.draft.softParts = this.draft.softParts.filter((p) => p.id !== s.id);
    });
    this.select(null);
  }

  private duplicateSelected(): void {
    const s = this.sel;
    if (!s || s.kind === 'joint') return;
    if (s.kind === 'part') {
      const p = this.draft.parts.find((x) => x.id === s.id);
      if (!p) return;
      const id = this.nextId('part');
      this.change(() => this.draft.parts.push({ ...JSON.parse(JSON.stringify(p)), id, name: `${p.name} copy`, position: [p.position[0] + 0.3, p.position[1], p.position[2] + 0.3] }));
      this.select({ kind: 'part', id });
    } else {
      const p = this.draft.softParts.find((x) => x.id === s.id);
      if (!p) return;
      const id = this.nextId(p.type);
      this.change(() => this.draft.softParts.push({ ...JSON.parse(JSON.stringify(p)), id, position: [p.position[0] + 0.4, p.position[1], p.position[2] + 0.4] }));
      this.select({ kind: 'soft', id });
    }
  }

  /** Merge the multi-selection into the first part (one rigid body, compound collider). */
  private mergeSelected(): void {
    const ids = [...this.multi];
    if (this.sel?.kind === 'part' && !ids.includes(this.sel.id)) ids.unshift(this.sel.id);
    if (ids.length < 2) return;
    this.change(() => {
      const target = this.draft.parts.find((p) => p.id === ids[0])!;
      const tPos = new THREE.Vector3(...target.position);
      const tInv = quatFromDeg(target.rotation).invert();
      for (const id of ids.slice(1)) {
        const p = this.draft.parts.find((x) => x.id === id);
        if (!p) continue;
        const pq = quatFromDeg(p.rotation);
        for (const s of p.shapes) {
          const wp = new THREE.Vector3(...s.position).applyQuaternion(pq).add(new THREE.Vector3(...p.position));
          const lp = wp.sub(tPos).applyQuaternion(tInv);
          const lq = tInv.clone().multiply(pq).multiply(quatFromDeg(s.rotation));
          const material = s.material ?? p.material;
          target.shapes.push({ ...s, position: [round(lp.x), round(lp.y), round(lp.z)], rotation: degFromQuat(lq), material });
        }
        this.draft.parts = this.draft.parts.filter((x) => x.id !== id);
        for (const j of this.draft.joints) {
          if (j.a === id) j.a = target.id;
          if (j.b === id) j.b = target.id;
        }
        this.draft.joints = this.draft.joints.filter((j) => j.a !== j.b);
      }
    });
    this.multi.clear();
    this.select({ kind: 'part', id: ids[0] });
  }

  private splitSelected(): void {
    const s = this.sel;
    if (s?.kind !== 'part') return;
    const p = this.draft.parts.find((x) => x.id === s.id);
    if (!p || p.shapes.length < 2) return;
    this.change(() => {
      const pq = quatFromDeg(p.rotation);
      const rest = p.shapes.splice(1);
      for (const sh of rest) {
        const wp = new THREE.Vector3(...sh.position).applyQuaternion(pq).add(new THREE.Vector3(...p.position));
        const wq = pq.clone().multiply(quatFromDeg(sh.rotation));
        this.draft.parts.push({ ...JSON.parse(JSON.stringify(p)), id: this.nextId('part'), name: `${p.name} piece`, position: [round(wp.x), round(wp.y), round(wp.z)], rotation: degFromQuat(wq), shapes: [{ ...sh, position: [0, 0, 0], rotation: [0, 0, 0], material: sh.material }] });
      }
    });
  }

  private async newModel(): Promise<void> {
    const dirty = (this.draft.parts.length || this.draft.softParts.length) && !this.progress.saved;
    if (dirty && !(await confirmDialog('Start a new model?', 'Anything you haven’t saved to the library will be lost.', { confirm: 'Start over', danger: true }))) return;
    this.cancelJoint();
    this.progress = { moved: false, tested: false, saved: false };
    this.draft = emptyModel();
    this.nameInput.value = this.draft.name;
    this.history = [];
    this.future = [];
    this.syncUndo();
    this.select(null);
    this.rebuild();
  }

  // ------------------------------------------------------------------ save / export

  private finalModel(): ModelDef {
    const name = this.nameInput.value.trim() || 'My model';
    const id = this.draft.id.startsWith('user-') ? this.draft.id : this.app.library.uniqueId(name);
    return parseModel({ ...JSON.parse(JSON.stringify(this.draft)), id, name, category: 'My Models' });
  }

  private async save(): Promise<void> {
    if (!this.draft.parts.length && !this.draft.softParts.length) {
      this.app.toast('Nothing to save yet', 'error');
      return;
    }
    const m = this.finalModel();
    await this.app.library.saveUserModel(m);
    this.draft.id = m.id;
    this.draft.name = m.name;
    this.progress.saved = true;
    this.renderChecklist();
    this.app.libraryPanel.refreshThumb(m.id);
    this.app.toast(`Saved “${m.name}” to My Models`);
  }

  exportMenu(): void {
    const pick = (fn: () => void) => () => { m.close(); fn(); };
    const body = h('div', {},
      h('h2', {}, 'Export model'),
      h('p', { class: 'sub' }, 'Save a copy as a file to share it or keep editing it elsewhere.'),
      h('div', { class: 'export-choices' },
        h('button', { class: 'export-choice', onclick: pick(() => this.exportGLB()) },
          h('b', {}, 'Blender / 3D file (.glb)'), h('span', { class: 'insp-sub' }, 'Opens in Blender with its physics settings kept; drop it back in here to re-import.')),
        h('button', { class: 'export-choice', onclick: pick(() => this.exportJSON()) },
          h('b', {}, 'Model file (.physmodel.json)'), h('span', { class: 'insp-sub' }, 'Small text file with every part, joint and material.'))),
      h('div', { class: 'footer' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel')));
    const m = modal(body, { small: true });
  }

  private async exportJSON(): Promise<void> {
    const m = this.finalModel();
    await this.app.platform.saveFile(`${m.id.replace(/^user-/, '')}.physmodel.json`, new Blob([exportModelJSON(m)], { type: 'application/json' }));
  }

  private async exportGLB(): Promise<void> {
    const m = this.finalModel();
    try {
      const glb = await exportModelGLB(m);
      await this.app.platform.saveFile(`${m.id.replace(/^user-/, '')}.glb`, new Blob([glb], { type: 'model/gltf-binary' }));
    } catch (err) {
      console.error(err);
      this.app.toast('GLB export failed', 'error');
    }
  }

  // ------------------------------------------------------------------ scene

  private key(s: Sel): string {
    return s.kind === 'joint' ? `joint:${s.index}` : `${s.kind}:${s.id}`;
  }

  private objectFor(s: Sel): THREE.Object3D | undefined {
    return this.objects.get(this.key(s));
  }

  private rebuild(): void {
    this.tc.detach();
    for (const o of [...this.root.children]) {
      this.root.remove(o);
      disposeOwned(o);
    }
    this.objects.clear();
    for (const part of this.draft.parts) {
      const g = new THREE.Group();
      g.position.set(...part.position);
      g.quaternion.copy(quatFromDeg(part.rotation));
      g.userData.sel = { kind: 'part', id: part.id } satisfies Sel;
      const spec = resolveMaterial(part.material);
      for (const s of part.shapes) {
        let obj: THREE.Object3D | null;
        const sSpec = s.material ? resolveMaterial(s.material) : spec;
        if (s.type === 'mesh') {
          obj = cloneAssetNode(s.asset, s.node);
          if (obj) {
            obj.scale.set(...s.scale);
            const keep = (s.material ?? part.material) === 'original' && !s.asset.startsWith('proc:');
            if (!keep) obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = makeThreeMaterial(sSpec); });
          }
        } else obj = new THREE.Mesh(primitiveGeometry(s), makeThreeMaterial(sSpec));
        if (!obj) continue;
        obj.position.set(...s.position);
        obj.quaternion.copy(quatFromDeg(s.rotation));
        if (!s.visible) obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = HIDDEN_SHAPE_MAT; });
        obj.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
        g.add(obj);
      }
      this.root.add(g);
      this.objects.set(`part:${part.id}`, g);
    }
    this.draft.joints.forEach((j, i) => {
      const g = new THREE.Group();
      g.position.set(...j.anchor);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...j.axis).normalize());
      const ball = new THREE.Mesh(JOINT_DOT_GEO, JOINT_DOT_MAT);
      ball.renderOrder = 10;
      g.add(ball);
      if (j.type === 'hinge' || j.type === 'slider') {
        const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -0.3), 0.6, 0xff8a3d, 0.1, 0.06);
        g.add(arrow);
      }
      if ((j.type === 'spring' || j.type === 'rope') && j.anchorB) {
        const pB = new THREE.Vector3(...j.anchorB).sub(new THREE.Vector3(...j.anchor)).applyQuaternion(g.quaternion.clone().invert());
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), pB]), new THREE.LineBasicMaterial({ color: 0xff8a3d }));
        line.userData.ownGeo = line.userData.ownMat = true;
        g.add(line);
      }
      g.userData.sel = { kind: 'joint', index: i } satisfies Sel;
      this.root.add(g);
      this.objects.set(`joint:${i}`, g);
    });
    for (const sp of this.draft.softParts) {
      const spec = resolveMaterial(sp.material);
      let geo: THREE.BufferGeometry;
      if (sp.type === 'cloth') geo = new THREE.PlaneGeometry(sp.size[0], sp.size[1], 8, 8);
      else if (sp.type === 'softbody') geo = sp.shape === 'box' ? new THREE.BoxGeometry(...sp.size) : sp.shape === 'torus' ? new THREE.TorusGeometry(sp.size[0], sp.size[1], 16, 32) : new THREE.SphereGeometry(1, 32, 16).scale(...sp.size);
      else geo = new THREE.BoxGeometry(...sp.size);
      const mat = sp.type === 'fluid' ? WATER_PREVIEW_MAT : makeThreeMaterial(spec, { side: THREE.DoubleSide });
      const m = new THREE.Mesh(geo, mat);
      m.userData.ownGeo = true;
      m.position.set(...sp.position);
      if (sp.type !== 'fluid') m.quaternion.copy(quatFromDeg(sp.rotation));
      m.userData.sel = { kind: 'soft', id: sp.id } satisfies Sel;
      m.castShadow = true;
      this.root.add(m);
      this.objects.set(`soft:${sp.id}`, m);
    }
    if (this.sel && !this.objectFor(this.sel)) this.sel = null;
    if (this.sel && !this.testing) {
      const o = this.objectFor(this.sel)!;
      this.tc.attach(o);
    }
    this.renderList();
    this.renderProps();
    this.app.pt?.markSceneDirty();
    this.app.pt?.markMaterialsDirty();
  }

  private select(s: Sel | null, additive = false): void {
    if (additive && s?.kind === 'part') {
      if (this.sel?.kind === 'part') this.multi.add(this.sel.id);
      if (this.multi.has(s.id)) this.multi.delete(s.id);
      else this.multi.add(s.id);
    } else if (!additive) {
      this.multi.clear();
    }
    this.sel = s;
    this.tc.detach();
    const o = s ? this.objectFor(s) : undefined;
    if (o && !this.testing) this.tc.attach(o);
    if (s?.kind === 'joint' && this.tc.mode === 'scale') this.setGizmo('translate');
    this.renderList();
    this.renderProps();
  }

  private hitSel(x: number, y: number): Sel | null {
    const ray = this.app.ray(x, y);
    const rc = new THREE.Raycaster(ray.origin, ray.direction);
    for (const hit of rc.intersectObjects(this.root.children, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && !o.userData.sel) o = o.parent;
      if (o) return o.userData.sel as Sel;
    }
    return null;
  }

  private pickAt(x: number, y: number, shift: boolean): void {
    const s = this.hitSel(x, y);
    if (s) this.select(s, shift);
    else if (!shift) this.select(null);
  }

  // ------------------------------------------------------------------ gizmo

  private setGizmo(mode: 'translate' | 'rotate' | 'scale'): void {
    if (mode === 'scale' && this.sel?.kind === 'joint') return;
    this.tc.setMode(mode);
    for (const [k, b] of Object.entries(this.gizmoBtns)) {
      b.classList.toggle('active', k === mode);
      b.setAttribute('aria-pressed', String(k === mode));
    }
  }

  private setSnap(on: boolean): void {
    this.snap = on;
    prefs.set('builder-snap', on ? '1' : '0');
    this.snapBtn.classList.toggle('active', on);
    this.snapBtn.setAttribute('aria-pressed', String(on));
    this.applySnap(on);
  }

  private applySnap(on: boolean): void {
    this.tc.setTranslationSnap(on ? SNAP_MOVE : null);
    this.tc.setRotationSnap(on ? SNAP_TURN : null);
    this.tc.setScaleSnap(on ? SNAP_SCALE : null);
  }

  /** Copy the gizmo transform back into the draft. */
  private commitTransform(final: boolean): void {
    const s = this.sel;
    if (!s) return;
    if (final && !this.progress.moved) {
      this.progress.moved = true;
      this.renderChecklist();
    }
    const o = this.objectFor(s);
    if (!o) return;
    const pos: V3 = [round(o.position.x), round(o.position.y), round(o.position.z)];
    if (s.kind === 'part') {
      const p = this.draft.parts.find((x) => x.id === s.id);
      if (!p) return;
      p.position = pos;
      p.rotation = degFromQuat(o.quaternion);
      if (final && (Math.abs(o.scale.x - 1) > 1e-3 || Math.abs(o.scale.y - 1) > 1e-3 || Math.abs(o.scale.z - 1) > 1e-3)) {
        this.bakeScale(p, o.scale.clone());
        o.scale.set(1, 1, 1);
        this.rebuild();
        return;
      }
    } else if (s.kind === 'joint') {
      const j = this.draft.joints[s.index];
      if (!j) return;
      const delta = new THREE.Vector3(...pos).sub(new THREE.Vector3(...j.anchor));
      j.anchor = pos;
      if (j.anchorB && (j.type === 'spring' || j.type === 'rope')) {
        // Moving a spring moves both ends.
        j.anchorB = [round(j.anchorB[0] + delta.x), round(j.anchorB[1] + delta.y), round(j.anchorB[2] + delta.z)];
      }
      const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
      j.axis = [round(axis.x), round(axis.y), round(axis.z)];
    } else {
      const sp = this.draft.softParts.find((x) => x.id === s.id);
      if (!sp) return;
      sp.position = pos;
      if (sp.type !== 'fluid') sp.rotation = degFromQuat(o.quaternion);
      if (final && Math.abs(o.scale.x * o.scale.y * o.scale.z - 1) > 1e-3) {
        if (sp.type === 'cloth') sp.size = [round(sp.size[0] * o.scale.x), round(sp.size[1] * o.scale.y)];
        else sp.size = [round(sp.size[0] * o.scale.x), round(sp.size[1] * o.scale.y), round(sp.size[2] * o.scale.z)];
        o.scale.set(1, 1, 1);
        this.rebuild();
        return;
      }
    }
    if (final) this.renderProps();
  }

  private bakeScale(p: PartDef, s: THREE.Vector3): void {
    const uni = Math.max(s.x, s.y, s.z);
    for (const sh of p.shapes) {
      const straight = sh.rotation.every((r) => Math.abs(r % 90) < 1e-3);
      sh.position = [round(sh.position[0] * s.x), round(sh.position[1] * s.y), round(sh.position[2] * s.z)];
      switch (sh.type) {
        case 'box': sh.size = straight ? [round(sh.size[0] * s.x), round(sh.size[1] * s.y), round(sh.size[2] * s.z)] : sh.size.map((v) => round(v * uni)) as V3; break;
        case 'sphere': sh.radius = round(sh.radius * uni); break;
        case 'cylinder': case 'capsule': case 'cone':
          sh.radius = round(sh.radius * Math.max(s.x, s.z));
          sh.height = round(sh.height * (straight ? s.y : uni));
          break;
        case 'mesh': sh.scale = [round(sh.scale[0] * s.x), round(sh.scale[1] * s.y), round(sh.scale[2] * s.z)]; break;
      }
    }
  }

  // ------------------------------------------------------------------ UI

  private fillMeshSelect(sel: HTMLSelectElement): void {
    sel.replaceChildren(h('option', { value: '' }, 'Add a mesh…'), ...allAssets().map((a) => h('option', { value: a.id }, a.source === 'proc' ? `${a.name} (built-in)` : a.name)));
  }

  private renderList(): void {
    const items: HTMLElement[] = [];
    const isSel = (s: Sel) => this.sel && this.key(this.sel) === this.key(s);
    for (const p of this.draft.parts) {
      const s: Sel = { kind: 'part', id: p.id };
      items.push(h('div', { class: `bp-item${isSel(s) || this.multi.has(p.id) ? ' selected' : ''}`, onclick: (e: Event) => this.select(s, (e as MouseEvent).shiftKey) },
        p.name, h('span', { class: 'tag' }, `${p.body === 'fixed' ? 'fixed · ' : ''}${p.shapes.length} shape${p.shapes.length > 1 ? 's' : ''}`)));
    }
    this.draft.joints.forEach((j, i) => {
      const s: Sel = { kind: 'joint', index: i };
      const a = this.draft.parts.find((p) => p.id === j.a)?.name ?? j.a;
      const b = j.b ? this.draft.parts.find((p) => p.id === j.b)?.name ?? j.b : 'world';
      items.push(h('div', { class: `bp-item joint${isSel(s) ? ' selected' : ''}`, onclick: () => this.select(s) }, `${j.type}: ${a} ↔ ${b}`, h('span', { class: 'tag' }, j.motor ? 'motor' : '')));
    });
    for (const sp of this.draft.softParts) {
      const s: Sel = { kind: 'soft', id: sp.id };
      items.push(h('div', { class: `bp-item${isSel(s) ? ' selected' : ''}`, onclick: () => this.select(s) }, sp.name, h('span', { class: 'tag' }, sp.type)));
    }
    if (!items.length) items.push(h('div', { class: 'lib-empty' }, 'Your model is empty — add a shape above to begin.'));
    this.list.replaceChildren(...items);
    this.renderChecklist();
  }

  /** Five steps from nothing to a saved model; hides itself once it's all done. */
  private renderChecklist(): void {
    const d = this.draft;
    const steps: [boolean, string][] = [
      [d.parts.length + d.softParts.length > 0, 'Add shapes'],
      [this.progress.moved, 'Move, turn or resize them with the arrows'],
      [d.joints.length > 0 || d.parts.length === 1, 'Connect parts with a joint'],
      [this.progress.tested, 'Press Test and play with it'],
      [this.progress.saved, 'Save it to your library'],
    ];
    const done = steps.every(([ok]) => ok);
    this.checklist.classList.toggle('hidden', done || prefs.get('builder-checklist') === 'hidden');
    if (done) return;
    const next = steps.findIndex(([ok]) => !ok);
    this.checklist.replaceChildren(
      h('h4', {}, 'Getting started',
        h('button', { class: 'bp-hide', title: 'Hide these steps', 'aria-label': 'Hide steps', onclick: () => { prefs.set('builder-checklist', 'hidden'); this.checklist.classList.add('hidden'); } }, '×')),
      ...steps.map(([ok, text], i) => h('div', { class: `bp-step${ok ? ' done' : ''}${i === next ? ' next' : ''}` }, h('span', { class: 'tick' }, ok ? '✓' : String(i + 1)), text)));
  }

  private row(label: string, ...controls: HTMLElement[]): HTMLElement {
    return h('div', { class: 'insp-row' }, h('label', {}, label), ...controls);
  }

  private num(value: number, onChange: (v: number) => void, step = 0.01): HTMLInputElement {
    const i = h('input', { type: 'number', value: String(round(value)), step });
    i.addEventListener('keydown', (e) => e.stopPropagation());
    i.addEventListener('change', () => {
      const v = Number(i.value);
      if (Number.isFinite(v)) this.change(() => onChange(v));
    });
    return i;
  }

  private vec(value: readonly number[], onChange: (v: V3) => void, step = 0.01): HTMLElement {
    const wrap = h('div', { class: 'vec-inputs' });
    const inputs = value.map((v) => {
      const i = h('input', { type: 'number', value: String(round(v)), step });
      i.addEventListener('keydown', (e) => e.stopPropagation());
      i.addEventListener('change', () => {
        const vals = inputs.map((x) => Number(x.value));
        if (vals.every(Number.isFinite)) this.change(() => onChange(vals as V3));
      });
      wrap.append(i);
      return i;
    });
    return wrap;
  }

  private select_(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
    const s = h('select', {}, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    s.addEventListener('change', () => this.change(() => onChange(s.value)));
    return s;
  }

  private check(value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const c = h('input', { type: 'checkbox', checked: value });
    c.addEventListener('change', () => this.change(() => onChange(c.checked)));
    return c;
  }

  private materialOptions(): [string, string][] {
    return MATERIAL_PRESETS.map((m) => [m.id, m.label]);
  }

  private renderProps(): void {
    const s = this.sel;
    const out: HTMLElement[] = [];
    const actions = (...btns: HTMLElement[]) => h('div', { class: 'insp-actions' }, ...btns);
    if (!s) {
      if (this.multi.size > 1) out.push(actions(h('button', { class: 'btn small', onclick: () => this.mergeSelected() }, 'Merge into one body')));
      out.push(h('div', { class: 'insp-sub' }, isTouch()
        ? 'Tip: tap a part to select it, then drag the arrows to move it.'
        : 'Tips: Shift-click to multi-select · Ctrl+D duplicate · Del delete · Ctrl+Z undo'));
      this.props.replaceChildren(...out);
      return;
    }
    if (s.kind === 'part') {
      const p = this.draft.parts.find((x) => x.id === s.id);
      if (!p) return;
      const name = h('input', { type: 'text', value: p.name });
      name.addEventListener('keydown', (e) => e.stopPropagation());
      name.addEventListener('change', () => this.change(() => (p.name = name.value || p.name)));
      out.push(h('h4', {}, 'Part'), this.row('Name', name));
      out.push(this.row('Body', this.select_([['dynamic', 'Dynamic'], ['fixed', 'Fixed (anchored)']], p.body, (v) => (p.body = v as PartDef['body']))));
      const matId = typeof p.material === 'string' ? p.material : '';
      out.push(this.row('Material', this.select_([['', '— custom —'], ...this.materialOptions()], matId, (v) => { if (v) p.material = v; })));
      const spec = resolveMaterial(p.material);
      out.push(this.row('Density', this.num(p.density ?? spec.density, (v) => (p.density = Math.max(1, v)), 10)));
      out.push(this.row('Friction', this.num(p.friction ?? spec.friction, (v) => (p.friction = Math.max(0, v)))));
      out.push(this.row('Bounce', this.num(p.restitution ?? spec.restitution, (v) => (p.restitution = Math.min(1, Math.max(0, v))))));
      out.push(this.row('Position', this.vec(p.position, (v) => (p.position = v))));
      out.push(this.row('Rotation°', this.vec(p.rotation, (v) => (p.rotation = v), 1)));
      out.push(this.row('Attractor', this.check(p.attractor, (v) => (p.attractor = v))));
      p.shapes.forEach((sh, k) => {
        out.push(h('h4', { style: 'margin-top:10px' }, `Shape ${k + 1} · ${sh.type}`));
        switch (sh.type) {
          case 'box': out.push(this.row('Size', this.vec(sh.size, (v) => (sh.size = v.map((x) => Math.max(0.01, x)) as V3)))); break;
          case 'sphere': out.push(this.row('Radius', this.num(sh.radius, (v) => (sh.radius = Math.max(0.01, v))))); break;
          case 'mesh':
            out.push(this.row('Scale', this.vec(sh.scale, (v) => (sh.scale = v))));
            out.push(this.row('Collider', this.select_([['hull', 'Convex hull'], ['box', 'Box'], ['sphere', 'Sphere'], ['trimesh', 'Exact (fixed only)']], sh.collider, (v) => (sh.collider = v as typeof sh.collider))));
            break;
          default:
            out.push(this.row('Radius', this.num(sh.radius, (v) => (sh.radius = Math.max(0.01, v)))));
            out.push(this.row('Height', this.num(sh.height, (v) => (sh.height = Math.max(0.01, v)))));
        }
        if (p.shapes.length > 1) {
          out.push(this.row('Offset', this.vec(sh.position, (v) => (sh.position = v))));
          out.push(this.row('Rotation°', this.vec(sh.rotation, (v) => (sh.rotation = v), 1)));
        }
        const smat = typeof sh.material === 'string' ? sh.material : '';
        out.push(this.row('Material', this.select_([['', '(part material)'], ...this.materialOptions()], smat, (v) => (sh.material = v || undefined))));
      });
      out.push(actions(
        h('button', { class: 'btn small', onclick: () => this.duplicateSelected() }, 'Duplicate'),
        p.shapes.length > 1 ? h('button', { class: 'btn small', onclick: () => this.splitSelected() }, 'Split shapes') : null as unknown as HTMLElement,
        this.multi.size ? h('button', { class: 'btn small', onclick: () => this.mergeSelected() }, 'Merge selected') : null as unknown as HTMLElement,
        h('button', { class: 'btn small danger', onclick: () => this.deleteSelected() }, 'Delete'),
      ));
    } else if (s.kind === 'joint') {
      const j = this.draft.joints[s.index];
      if (!j) return;
      const partOpts: [string, string][] = this.draft.parts.map((p) => [p.id, p.name]);
      out.push(h('h4', {}, 'Joint'));
      out.push(this.row('Type', this.select_(JOINT_TYPES.map((t) => [t, t]), j.type, (v) => (j.type = v as JointDef['type']))));
      out.push(this.row('Part A', this.select_(partOpts, j.a, (v) => (j.a = v))));
      out.push(this.row('Part B', this.select_([['', 'World'], ...partOpts], j.b ?? '', (v) => (j.b = v || null))));
      out.push(this.row('Anchor', this.vec(j.anchor, (v) => (j.anchor = v))));
      if (j.type === 'hinge' || j.type === 'slider') {
        out.push(this.row('Axis', this.vec(j.axis, (v) => (j.axis = v))));
        out.push(this.row('Limits', this.check(!!j.limits, (v) => (j.limits = v ? (j.type === 'hinge' ? [-45, 45] : [-0.5, 0.5]) : undefined))));
        if (j.limits) out.push(this.row(j.type === 'hinge' ? 'Min / max°' : 'Min / max m', this.vec([j.limits[0], j.limits[1], 0].slice(0, 2), (v) => (j.limits = [v[0], v[1]]), 1)));
        out.push(this.row('Motor', this.check(!!j.motor, (v) => (j.motor = v ? { velocity: 2, force: 50 } : undefined))));
        if (j.motor) {
          out.push(this.row('Speed', this.num(j.motor.velocity, (v) => (j.motor!.velocity = v), 0.1)));
          out.push(this.row('Strength', this.num(j.motor.force, (v) => (j.motor!.force = Math.max(0.1, v)), 1)));
        }
      }
      if (j.type === 'spring' || j.type === 'rope') {
        out.push(this.row('Anchor B', this.vec(j.anchorB ?? j.anchor, (v) => (j.anchorB = v))));
        out.push(this.row('Length', this.num(j.length ?? 0, (v) => (j.length = v > 0 ? v : undefined))));
        if (j.type === 'spring') {
          out.push(this.row('Stiffness', this.num(j.stiffness, (v) => (j.stiffness = Math.max(0.1, v)), 10)));
          out.push(this.row('Damping', this.num(j.damping, (v) => (j.damping = Math.max(0, v)), 0.5)));
        }
      }
      out.push(this.row('Collide', this.check(j.collide, (v) => (j.collide = v))));
      out.push(actions(h('button', { class: 'btn small danger', onclick: () => this.deleteSelected() }, 'Delete')));
    } else {
      const sp = this.draft.softParts.find((x) => x.id === s.id);
      if (!sp) return;
      out.push(h('h4', {}, sp.type === 'softbody' ? 'Soft body' : sp.type === 'cloth' ? 'Cloth' : 'Water'));
      out.push(this.row('Position', this.vec(sp.position, (v) => (sp.position = v))));
      const matId = typeof sp.material === 'string' ? sp.material : '';
      out.push(this.row('Material', this.select_([['', '— custom —'], ...this.materialOptions()], matId, (v) => { if (v) sp.material = v; })));
      if (sp.type === 'cloth') {
        out.push(this.row('Rotation°', this.vec(sp.rotation, (v) => (sp.rotation = v), 1)));
        out.push(this.row('Size', this.vec([...sp.size, 0].slice(0, 2), (v) => (sp.size = [Math.max(0.1, v[0]), Math.max(0.1, v[1])]))));
        out.push(this.row('Resolution', this.vec([...sp.resolution], (v) => (sp.resolution = [Math.max(2, Math.round(v[0])), Math.max(2, Math.round(v[1]))]), 1)));
        out.push(this.row('Pins', this.select_([['none', 'None'], ['top-edge', 'Top edge'], ['top-corners', 'Top corners'], ['corners', 'All corners'], ['left-edge', 'Left edge'], ['all-edges', 'All edges']], sp.pins, (v) => (sp.pins = v as typeof sp.pins))));
        out.push(this.row('Attach to', this.select_([['', 'World'], ...this.draft.parts.map((p) => [p.id, p.name] as [string, string])], sp.attachTo ?? '', (v) => (sp.attachTo = v || null))));
        out.push(this.row('Stretch', this.num(sp.stretch, (v) => (sp.stretch = Math.max(0, v)), 0.001)));
        out.push(this.row('Bend', this.num(sp.bend, (v) => (sp.bend = Math.max(0, v)), 0.005)));
        out.push(this.row('kg / m²', this.num(sp.areaDensity, (v) => (sp.areaDensity = Math.max(0.01, v)), 0.05)));
      } else if (sp.type === 'softbody') {
        out.push(this.row('Shape', this.select_([['sphere', 'Sphere'], ['box', 'Box'], ['torus', 'Ring']], sp.shape, (v) => (sp.shape = v as typeof sp.shape))));
        out.push(this.row('Size', this.vec(sp.size, (v) => (sp.size = v.map((x) => Math.max(0.03, x)) as V3))));
        out.push(this.row('Detail', this.num(sp.detail, (v) => (sp.detail = Math.min(4, Math.max(0, Math.round(v)))), 1)));
        out.push(this.row('Mass kg', this.num(sp.mass, (v) => (sp.mass = Math.max(0.01, v)), 0.1)));
        out.push(this.row('Pressure', this.num(sp.pressure, (v) => (sp.pressure = Math.max(0, v)), 0.05)));
        out.push(this.row('Jelly', this.num(sp.shapeMatching, (v) => (sp.shapeMatching = Math.min(1, Math.max(0, v))), 0.05)));
        out.push(this.row('Softness', this.num(sp.compliance, (v) => (sp.compliance = Math.max(0, v)), 0.0005)));
      } else {
        out.push(this.row('Size', this.vec(sp.size, (v) => (sp.size = v.map((x) => Math.max(0.05, x)) as V3))));
        out.push(this.row('Viscosity', this.num(sp.viscosity, (v) => (sp.viscosity = Math.min(1, Math.max(0, v))), 0.01)));
        out.push(this.row('Emitter', this.check(!!sp.emitter, (v) => (sp.emitter = v ? { rate: 300, velocity: [0, 1, 2.5], radius: 0.07, total: 1500 } : undefined))));
        if (sp.emitter) {
          out.push(this.row('Jet m/s', this.vec(sp.emitter.velocity, (v) => (sp.emitter!.velocity = v), 0.1)));
          out.push(this.row('Rate /s', this.num(sp.emitter.rate, (v) => (sp.emitter!.rate = Math.max(1, v)), 10)));
          out.push(this.row('Total', this.num(sp.emitter.total, (v) => (sp.emitter!.total = Math.max(1, Math.round(v))), 100)));
        }
      }
      out.push(actions(
        h('button', { class: 'btn small', onclick: () => this.duplicateSelected() }, 'Duplicate'),
        h('button', { class: 'btn small danger', onclick: () => this.deleteSelected() }, 'Delete'),
      ));
    }
    this.props.replaceChildren(...out.filter(Boolean));
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active || this.testing) return;
    if (document.querySelector('.modal-back, .tour-layer')) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.duplicateSelected();
      return;
    }
    if (mod) return;
    switch (e.key) {
      case 'w': case 'W': this.setGizmo('translate'); break;
      case 'e': case 'E': this.setGizmo('rotate'); break;
      case 'r': case 'R': this.setGizmo('scale'); break;
      case 'Delete': case 'Backspace': this.deleteSelected(); break;
      case 'Escape':
        if (this.jointMode) { e.stopImmediatePropagation(); this.cancelJoint(); }
        else if (this.sel) { e.stopImmediatePropagation(); this.select(null); }
        break;
    }
  }
}
