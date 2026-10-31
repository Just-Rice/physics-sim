import * as THREE from 'three';
import { SettingsStore, defaultSettings, type Settings } from './settings';
import type { AppContext, ParticleTools, PickResult } from './context';
import { initRapier, RAPIER } from '../physics/RigidWorld';
import { Simulation } from '../sim/Simulation';
import { RasterRenderer } from '../render/RasterRenderer';
import { PathTracer, pathTracingUnsupportedReason } from '../render/PathTracer';
import { Flashes, SelectionBox, Trails } from '../render/effects';
import { ModelLibrary } from '../models/library';
import { ThumbnailRenderer } from '../models/thumbnails';
import { registerProceduralAssets } from '../models/assets';
import type { ModelDef } from '../models/schema';
import type { Entity, PartInstance } from '../sim/types';
import { ToolManager } from '../tools/ToolManager';
import { TopBar } from '../ui/TopBar';
import { LibraryPanel } from '../ui/LibraryPanel';
import { BottomBar } from '../ui/BottomBar';
import { Inspector } from '../ui/Inspector';
import { SettingsPanel } from '../ui/SettingsPanel';
import { Toasts, h } from '../ui/dom';
import { showHelp } from '../ui/help';
import { SCENARIOS, type Scenario } from '../scenes/scenarios';
import { isSavedScene, resolveSavedModel, serializeScene } from '../scenes/sceneIO';
import { detectPlatform, type MenuCommand, type Platform, type PickedFile } from '../platform';

export interface AppExtensions {
  /** Particle physics plugin (cloth, soft bodies, fluids). */
  createParticles?(app: App): (ParticleTools & { count(): number; active(): boolean; reset(): void }) | null;
  /** Model Builder mode. */
  createBuilder?(app: App): { enter(model?: ModelDef): void; exit(): void; update(dt: number): void; readonly el: HTMLElement[] } | null;
  /** File import (meshes and model JSON). */
  importFiles?(app: App, files: PickedFile[]): Promise<void>;
  /** Load stored mesh assets for the library. */
  assetLoader?: ModelLibrary['assetLoader'];
  exportModel?(app: App, model: ModelDef): Promise<void>;
}

export class App implements AppContext {
  readonly settings: SettingsStore;
  readonly platform: Platform;
  readonly library = new ModelLibrary();
  view!: RasterRenderer;
  sim!: Simulation;
  particles: (ParticleTools & { count(): number; active(): boolean; reset(): void }) | null = null;
  selected: PartInstance | null = null;
  tools!: ToolManager;
  pt: PathTracer | null = null;
  private ptLoading = false;
  private ptUnsupported: string | null = null;
  private topbar!: TopBar;
  libraryPanel!: LibraryPanel;
  private bottombar!: BottomBar;
  private inspector!: Inspector;
  private settingsPanel!: SettingsPanel;
  private toasts = new Toasts();
  private thumbs!: ThumbnailRenderer;
  private flashes!: Flashes;
  private trails!: Trails;
  private selectionBox!: SelectionBox;
  private raycaster = new THREE.Raycaster();
  private rtBadge!: HTMLElement;
  private rtBar!: HTMLElement;
  private rtText!: HTMLElement;
  private hintEl!: HTMLElement;
  private timer = new THREE.Timer();
  private fps = 60;
  private photoRequest: { samples: number; resolve: () => void } | null = null;
  private lastMotion = 0;
  mode: 'play' | 'build' = 'play';
  builder: ReturnType<NonNullable<AppExtensions['createBuilder']>> = null;
  scenario: Scenario = SCENARIOS[0];

  constructor(private ext: AppExtensions = {}) {
    const s = defaultSettings();
    this.platform = detectPlatform();
    if (this.platform.kind === 'desktop') {
      // The Mac app defaults to higher quality.
      s.raytracing.liveRenderScale = 0.6;
      s.particles.maxParticles = 12000;
    }
    this.settings = new SettingsStore(s);
  }

  private status(msg: string): void {
    const el = document.getElementById('boot-status');
    if (el) el.textContent = msg;
  }

  async init(): Promise<void> {
    this.status('Loading physics engine…');
    await initRapier();
    registerProceduralAssets();
    this.library.assetLoader = this.ext.assetLoader ?? null;

    this.status('Starting renderer…');
    const viewport = document.getElementById('viewport')!;
    this.view = new RasterRenderer(viewport, this.settings);
    this.ptUnsupported = pathTracingUnsupportedReason(this.view.renderer);
    this.sim = new Simulation(this.settings);
    this.view.scene.add(this.sim.root);
    this.flashes = new Flashes(this.view.helpers);
    this.selectionBox = new SelectionBox(this.view.helpers);
    this.trails = new Trails(this.view.helpers, () => this.sim.parts);
    this.trails.setEnabled(this.settings.data.render.trails);
    this.sim.addPlugin(this.trails);
    this.particles = this.ext.createParticles?.(this) ?? null;
    this.view.onEnvironmentChange = () => this.pt?.markEnvironmentDirty();

    this.thumbs = new ThumbnailRenderer(this.view.renderer);
    this.tools = new ToolManager(this, this.view.renderer.domElement);
    this.buildUI();

    this.status('Loading your models…');
    await this.library.load();

    this.builder = this.ext.createBuilder?.(this) ?? null;
    if (this.builder) for (const el of this.builder.el) document.getElementById('ui')!.append(el);

    this.bindKeys();
    this.bindDrop();
    this.bindSettings();
    this.platform.onMenu?.((cmd) => this.menu(cmd));
    this.platform.onWatchedFile?.((f) => this.ext.importFiles?.(this, [f]));

    this.loadScenario('sandbox');
    document.getElementById('boot')?.classList.add('hidden');
    setTimeout(() => document.getElementById('boot')?.remove(), 600);
    this.view.renderer.setAnimationLoop(() => this.frame());
    // Exposed for debugging and automated smoke tests.
    (window as unknown as { physicsApp: App }).physicsApp = this;
  }

  // ------------------------------------------------------------------ UI

  private buildUI(): void {
    const ui = document.getElementById('ui')!;
    this.topbar = new TopBar(this.tools, {
      onScenario: (id) => this.loadScenario(id),
      onMode: (m) => this.setMode(m),
      onRayTracing: (on) => this.setRayTracing(on),
      onToggleSettings: () => this.toggleSettings(),
      onToggleLibrary: () => this.toggleLibrary(),
      onHelp: () => showHelp(this.platform.kind),
    });
    if (this.ptUnsupported) this.topbar.setRayTracingUnavailable(this.ptUnsupported);

    this.libraryPanel = new LibraryPanel(this.library, this.thumbs, {
      onPick: (m) => {
        this.tools.spawn.modelId = m.id;
        this.tools.setTool('spawn');
        this.libraryPanel.setActive(m.id);
        this.updateHint();
      },
      onImport: () => this.openImport(),
      onDelete: async (m) => {
        if (!confirm(`Delete “${m.name}” from your library?`)) return;
        await this.library.deleteUserModel(m.id);
        this.toast(`Deleted ${m.name}`);
      },
      onEdit: (m) => {
        this.setMode('build');
        this.builder?.enter(m);
      },
      onExport: (m) => this.ext.exportModel?.(this, m),
    });
    this.libraryPanel.setActive(this.tools.spawn.modelId);

    this.bottombar = new BottomBar(this.settings, {
      onTogglePause: () => this.togglePause(),
      onStep: () => this.stepOnce(),
      onReset: () => this.loadScenario(this.scenario.id),
      onClear: () => this.clearScene(),
      onPhoto: () => this.savePhoto(),
    });

    this.inspector = new Inspector({
      onDelete: (p) => this.removeEntity(p.entity),
      onFocus: (p) => this.focusOn(p.object),
      onClose: () => this.select(null),
    });
    this.inspector.onMaterialChanged = () => this.pt?.markMaterialsDirty();

    this.settingsPanel = new SettingsPanel(this.settings, {
      onWatchFolder: this.platform.watchFolder ? () => this.chooseWatchFolder() : undefined,
      onPhoto: () => this.savePhoto(),
      onSaveScene: () => this.saveScene(),
      onLoadScene: () => this.loadSceneFile(),
    });

    this.rtBar = h('i');
    this.rtText = h('span');
    this.rtBadge = h('div', { class: 'rt-badge panel' }, this.rtText, h('div', { class: 'bar' }, this.rtBar));
    this.hintEl = h('div', { class: 'hint panel' });

    const rightCol = h('div', { class: 'right-col' }, this.inspector.el, this.settingsPanel.el);
    ui.append(this.topbar.el, this.libraryPanel.el, this.bottombar.el, rightCol, this.rtBadge, this.hintEl, this.toasts.el,
      h('div', { class: 'drop-overlay', id: 'drop-overlay' }, 'Drop to import'));
    this.tools.onChange(() => this.updateHint());
    this.updateHint();
  }

  private updateHint(): void {
    if (this.mode === 'build') {
      this.hintEl.style.display = 'none';
      return;
    }
    this.hintEl.style.display = '';
    this.hintEl.textContent = (this.tools.active as unknown as { hint: string }).hint;
  }

  toast(message: string, kind: 'info' | 'error' = 'info'): void {
    this.toasts.show(message, kind);
  }

  toggleSettings(force?: boolean): void {
    const open = force ?? !this.settingsPanel.isOpen;
    this.settingsPanel.setOpen(open);
    this.topbar.setSettingsOpen(open);
  }

  toggleLibrary(force?: boolean): void {
    const open = force ?? !this.libraryPanel.isOpen;
    this.libraryPanel.setOpen(open);
    this.topbar.setLibraryOpen(open);
  }

  private bindSettings(): void {
    this.settings.on((p) => {
      if (p === 'render.trails') this.trails.setEnabled(this.settings.data.render.trails);
      if (p === 'raytracing.enabled') this.syncRayTracingUi();
    });
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey) {
        if (e.key === 's') {
          e.preventDefault();
          this.saveScene();
        } else if (e.key === 'o') {
          e.preventDefault();
          this.openImport();
        }
        return;
      }
      if (this.mode === 'build') {
        if (e.key === 'Escape') this.setMode('play');
        return;
      }
      const tool = this.tools.tools.find((t) => t.key === e.key);
      if (tool) {
        this.tools.setTool(tool.id);
        return;
      }
      switch (e.key) {
        case ' ': e.preventDefault(); this.togglePause(); break;
        case '.': this.stepOnce(); break;
        case 'r': case 'R': this.loadScenario(this.scenario.id); break;
        case 't': case 'T': this.setRayTracing(!this.settings.data.raytracing.enabled); break;
        case 'b': case 'B': this.setMode('build'); break;
        case 'l': case 'L': this.toggleLibrary(); break;
        case 'g': case 'G': this.toggleSettings(); break;
        case 'f': case 'F': if (this.selected) this.focusOn(this.selected.object); break;
        case 'p': case 'P': this.savePhoto(); break;
        case 'h': case 'H': case '?': showHelp(this.platform.kind); break;
        case 'Delete': case 'Backspace':
          if (e.shiftKey) this.clearScene();
          else if (this.selected) this.removeEntity(this.selected.entity);
          break;
        case 'Escape': this.select(null); this.tools.setTool('hand'); break;
      }
    });
    this.view.renderer.domElement.addEventListener('dblclick', (e) => {
      if (!this.settings.data.raytracing.dof) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (!hit) return;
      this.settings.set('raytracing', 'focusDistance', Math.round(hit.distance * 100) / 100);
      this.toast(`Focus set to ${hit.distance.toFixed(2)} m`);
    });
  }

  private bindDrop(): void {
    const overlay = () => document.getElementById('drop-overlay');
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; overlay()?.classList.add('visible'); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; overlay()?.classList.remove('visible'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      overlay()?.classList.remove('visible');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      const picked = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
      await this.handleFiles(picked);
    });
  }

  private async handleFiles(files: PickedFile[]): Promise<void> {
    // A saved scene?
    if (files.length === 1 && /\.json$/i.test(files[0].name)) {
      try {
        const json = JSON.parse(new TextDecoder().decode(files[0].bytes));
        if (isSavedScene(json)) {
          this.applySavedScene(json);
          return;
        }
      } catch {
        /* fall through to model import */
      }
    }
    if (!this.ext.importFiles) {
      this.toast('Import is not available', 'error');
      return;
    }
    await this.ext.importFiles(this, files);
  }

  async openImport(): Promise<void> {
    const files = await this.platform.openFiles({ accept: ['.glb', '.gltf', '.bin', '.obj', '.stl', '.json', '.png', '.jpg', '.jpeg'], multiple: true });
    if (files.length) await this.handleFiles(files);
  }

  private async chooseWatchFolder(): Promise<void> {
    const folder = await this.platform.watchFolder?.(true);
    if (folder) this.toast(`Watching ${folder} for Blender exports`);
  }

  private menu(cmd: MenuCommand): void {
    switch (cmd) {
      case 'open': this.openImport(); break;
      case 'save-scene': this.saveScene(); break;
      case 'load-scene': this.loadSceneFile(); break;
      case 'render-photo': this.savePhoto(); break;
      case 'toggle-raytracing': this.setRayTracing(!this.settings.data.raytracing.enabled); break;
      case 'toggle-pause': this.togglePause(); break;
      case 'step': this.stepOnce(); break;
      case 'reset': this.loadScenario(this.scenario.id); break;
      case 'help': showHelp(this.platform.kind); break;
      case 'watch-folder': this.chooseWatchFolder(); break;
      case 'build-mode': this.setMode('build'); break;
      case 'play-mode': this.setMode('play'); break;
      case 'export-model': if (this.mode === 'build') this.toast('Use Export in the builder bar'); break;
    }
  }

  // ------------------------------------------------------------------ simulation control

  togglePause(): void {
    this.settings.set('physics', 'paused', !this.settings.data.physics.paused);
  }

  stepOnce(): void {
    if (!this.settings.data.physics.paused) this.settings.set('physics', 'paused', true);
    this.sim.stepManual();
    this.pt?.markSceneDirty();
  }

  clearScene(): void {
    this.select(null);
    this.sim.clear();
    this.particles?.reset();
    this.pt?.markSceneDirty();
    this.toast('Cleared');
  }

  loadScenario(id: string): void {
    const sc = SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
    this.scenario = sc;
    this.topbar.scenarioSelect.value = sc.id;
    this.select(null);
    this.sim.clear();
    this.particles?.reset();
    this.trails.clear();

    const d = defaultSettings();
    const physKeys: (keyof Settings['physics'])[] = ['gravityMode', 'gravity', 'gravityPreset', 'G', 'windX', 'windZ', 'timeScale', 'airDrag'];
    for (const k of physKeys) {
      const v = (sc.physics as Record<string, unknown> | undefined)?.[k] ?? d.physics[k];
      this.settings.set('physics', k, v as never);
    }
    const renderKeys: (keyof Settings['render'])[] = ['environment', 'sunElevation', 'sunAzimuth', 'trails', 'exposure'];
    for (const k of renderKeys) {
      const v = (sc.render as Record<string, unknown> | undefined)?.[k] ?? d.render[k];
      this.settings.set('render', k, v as never);
    }
    const groundOn = sc.ground !== false;
    this.sim.setGroundEnabled(groundOn);
    this.view.ground.visible = groundOn;

    for (const p of sc.placements()) {
      const model = typeof p.model === 'string' ? this.library.get(p.model) : p.model;
      if (!model) {
        console.warn('Unknown model in scenario', p.model);
        continue;
      }
      this.sim.spawn(model, { model: model.id, position: p.position ?? [0, 0, 0], rotation: p.rotation ?? [0, 0, 0], velocity: p.velocity });
    }
    this.sim.sync(1);
    if (sc.camera) {
      this.view.camera.position.set(...sc.camera.position);
      this.view.controls.target.set(...sc.camera.target);
      this.view.controls.update();
    }
    this.pt?.markSceneDirty();
    this.pt?.markMaterialsDirty();
    this.pt?.reset();
  }

  setMode(mode: 'play' | 'build'): void {
    if (mode === this.mode) return;
    if (mode === 'build' && !this.builder) {
      this.toast('The Model Builder is not available', 'error');
      return;
    }
    this.mode = mode;
    this.topbar.setMode(mode);
    this.select(null);
    if (mode === 'build') {
      this.tools.setTool('hand');
      this.tools.enabled = false;
      this.libraryPanel.setOpen(false);
      this.sim.root.visible = false;
      this.particles?.pickables().forEach((o) => (o.visible = false));
      this.builder!.enter();
    } else {
      this.builder?.exit();
      this.tools.enabled = true;
      this.sim.root.visible = true;
      this.particles?.pickables().forEach((o) => (o.visible = true));
      this.libraryPanel.setOpen(true);
      this.topbar.setLibraryOpen(true);
    }
    this.updateHint();
    this.pt?.markSceneDirty();
  }

  // ------------------------------------------------------------------ AppContext

  select(part: PartInstance | null): void {
    this.selected = part;
    this.selectionBox.part = part;
    this.inspector.show(part);
  }

  ray(clientX: number, clientY: number): THREE.Ray {
    const rect = this.view.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.view.camera);
    return this.raycaster.ray.clone();
  }

  pick(clientX: number, clientY: number): PickResult | null {
    this.ray(clientX, clientY);
    const targets: THREE.Object3D[] = [this.sim.root, ...(this.particles?.pickables() ?? [])];
    if (this.view.ground.visible) targets.push(this.view.ground);
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      if (!hit.object.visible) continue;
      let o: THREE.Object3D | null = hit.object;
      let hidden = false;
      while (o) {
        if (!o.visible) hidden = true;
        o = o.parent;
      }
      if (hidden) continue;
      const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
      if (normal.dot(this.raycaster.ray.direction) > 0) normal.negate();
      const isGround = hit.object === this.view.ground;
      return {
        point: hit.point.clone(),
        normal,
        distance: hit.distance,
        part: isGround ? null : this.sim.partFromObject(hit.object),
        soft: this.particles?.softFromObject(hit.object) ?? null,
        object: hit.object,
        isGround,
      };
    }
    // Fall back to the ground plane even if it is hidden (space scenes) so spawn still works.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pt = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (pt && pt.distanceTo(this.view.camera.position) < 200) {
      return { point: pt, normal: new THREE.Vector3(0, 1, 0), distance: pt.distanceTo(this.view.camera.position), part: null, soft: null, object: this.view.ground, isGround: true };
    }
    return null;
  }

  spawnModel(modelOrId: ModelDef | string, position: THREE.Vector3, opts: { yaw?: number; velocity?: THREE.Vector3 } = {}): Entity | null {
    const model = typeof modelOrId === 'string' ? this.library.get(modelOrId) : modelOrId;
    if (!model) {
      this.toast(`Unknown model ${String(modelOrId)}`, 'error');
      return null;
    }
    const limit = 2500;
    if (this.sim.parts.length + model.parts.length > limit) {
      this.toast(`Body limit reached (${limit}). Clear some objects first.`, 'error');
      return null;
    }
    const e = this.sim.spawn(model, {
      model: model.id,
      position: [position.x, position.y, position.z],
      rotation: [0, opts.yaw ?? 0, 0],
      velocity: opts.velocity ? [opts.velocity.x, opts.velocity.y, opts.velocity.z] : undefined,
    });
    this.sim.sync(1);
    this.pt?.markSceneDirty();
    this.lastMotion = performance.now();
    return e;
  }

  removeEntity(e: Entity): void {
    if (e.locked) return;
    if (this.selected?.entity === e) this.select(null);
    this.sim.remove(e);
    this.pt?.markSceneDirty();
  }

  flash(point: THREE.Vector3, radius: number, color?: number): void {
    this.flashes.spawn(point, radius, color);
  }

  focusOn(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj);
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(0.3, box.getSize(new THREE.Vector3()).length());
    const dir = this.view.camera.position.clone().sub(this.view.controls.target).normalize();
    this.view.controls.target.copy(c);
    this.view.camera.position.copy(c).addScaledVector(dir, r * 2.2 + 0.5);
    this.view.controls.update();
  }

  // ------------------------------------------------------------------ ray tracing

  async setRayTracing(on: boolean): Promise<void> {
    if (on && this.ptUnsupported) {
      this.toast(this.ptUnsupported, 'error');
      return;
    }
    if (on && !this.pt) {
      if (this.ptLoading) return;
      this.ptLoading = true;
      this.topbar.setRayTracing(true, 'Loading…');
      try {
        this.pt = await PathTracer.create(this.view, this.settings);
      } catch (err) {
        console.error(err);
        this.toast('Could not start the path tracer', 'error');
        this.topbar.setRayTracing(false);
        this.ptLoading = false;
        return;
      }
      this.ptLoading = false;
    }
    this.settings.set('raytracing', 'enabled', on);
    this.pt?.markSceneDirty();
    this.pt?.markMaterialsDirty();
    this.pt?.markEnvironmentDirty();
    this.pt?.reset();
    this.syncRayTracingUi();
    if (on) this.toast('Ray tracing on — pause (Space) to let the image converge');
  }

  private syncRayTracingUi(): void {
    const on = this.settings.data.raytracing.enabled && !!this.pt;
    this.topbar.setRayTracing(on);
    this.rtBadge.classList.toggle('visible', on);
  }

  // ------------------------------------------------------------------ files

  async saveScene(): Promise<void> {
    const data = serializeScene(this.sim, this.library, this.settings.data, this.view.camera, this.view.controls.target, this.view.ground.visible);
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const ok = await this.platform.saveFile(`${this.scenario.id}-scene.json`, blob);
    if (ok) this.toast('Scene saved');
  }

  async loadSceneFile(): Promise<void> {
    const files = await this.platform.openFiles({ accept: ['.json'] });
    if (files.length) await this.handleFiles(files);
  }

  applySavedScene(scene: ReturnType<typeof serializeScene>): void {
    this.select(null);
    this.sim.clear();
    this.particles?.reset();
    for (const [k, v] of Object.entries(scene.physics)) this.settings.set('physics', k as keyof Settings['physics'], v as never);
    for (const [k, v] of Object.entries(scene.render)) this.settings.set('render', k as keyof Settings['render'], v as never);
    this.sim.setGroundEnabled(scene.ground);
    this.view.ground.visible = scene.ground;
    let missing = 0;
    for (const e of scene.entities) {
      const model = resolveSavedModel(e.model, this.library);
      if (!model) {
        missing++;
        continue;
      }
      const ent = this.sim.spawn(model, { model: model.id, position: e.placement.position, rotation: e.placement.rotation });
      for (const part of ent.parts) {
        const s = e.parts[part.def.id];
        if (!s) continue;
        const b = part.body;
        b.setTranslation({ x: s.p[0], y: s.p[1], z: s.p[2] }, true);
        b.setRotation({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] }, true);
        if (s.fixed && !b.isFixed()) b.setBodyType(RAPIER.RigidBodyType.Fixed, false);
        b.setLinvel({ x: s.v[0], y: s.v[1], z: s.v[2] }, true);
        b.setAngvel({ x: s.w[0], y: s.w[1], z: s.w[2] }, true);
        part.currPos.set(...s.p);
        part.prevPos.set(...s.p);
        part.currQuat.set(...s.q);
        part.prevQuat.set(...s.q);
      }
    }
    this.sim.sync(1);
    this.view.camera.position.set(...scene.camera.position);
    this.view.controls.target.set(...scene.camera.target);
    this.view.controls.update();
    this.pt?.markSceneDirty();
    this.pt?.markMaterialsDirty();
    this.toast(missing ? `Scene loaded (${missing} model(s) missing from your library)` : 'Scene loaded', missing ? 'error' : 'info');
  }

  async savePhoto(): Promise<void> {
    const rt = this.settings.data.raytracing.enabled && this.pt;
    if (rt) {
      const wasPaused = this.settings.data.physics.paused;
      this.settings.set('physics', 'paused', true);
      this.pt!.photoMode = true;
      this.pt!.reset();
      const target = Math.min(this.settings.data.raytracing.maxSamples, 400);
      this.toast(`Rendering ${target} samples…`);
      await new Promise<void>((resolve) => (this.photoRequest = { samples: target, resolve }));
      this.pt!.photoMode = false;
      if (!wasPaused) this.settings.set('physics', 'paused', false);
    } else {
      await new Promise<void>((resolve) => (this.photoRequest = { samples: 0, resolve }));
    }
  }

  private capturePhoto(): void {
    const canvas = this.view.renderer.domElement;
    const req = this.photoRequest!;
    this.photoRequest = null;
    canvas.toBlob(async (blob) => {
      if (blob) {
        const name = `physics-sim-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        const ok = await this.platform.saveFile(name, blob);
        if (ok) this.toast('Image saved');
      }
      req.resolve();
    }, 'image/png');
  }

  // ------------------------------------------------------------------ frame loop

  private anyMotion(): boolean {
    for (const p of this.sim.parts) {
      if (p.body.isDynamic() && !p.body.isSleeping()) return true;
    }
    return this.particles?.active() ?? false;
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    if (this.mode === 'play') {
      this.tools.update(dt);
      const before = this.sim.stepCount;
      const alpha = this.sim.advance(dt);
      this.sim.sync(alpha);
      const stepped = this.sim.stepCount !== before;
      if (stepped && this.anyMotion()) this.lastMotion = performance.now();
      if (stepped) this.pt?.markSceneDirty();
    } else {
      this.builder?.update(dt);
    }

    this.view.controls.update();
    this.flashes.update(dt);
    this.selectionBox.update();
    this.inspector.update();

    const rtOn = this.settings.data.raytracing.enabled && this.pt;
    if (rtOn) {
      const moving = !this.settings.data.physics.paused && performance.now() - this.lastMotion < 250;
      this.pt!.render(moving);
      this.updateRtBadge(moving);
    } else {
      this.view.render();
    }

    if (this.photoRequest && (!rtOn || this.pt!.samples >= this.photoRequest.samples)) this.capturePhoto();

    const st = this.sim.stats();
    this.bottombar.setStats({ fps: this.fps, bodies: st.bodies, particles: this.particles?.count() ?? 0, kinetic: st.kinetic });
  }

  private lastBadge = 0;
  private updateRtBadge(moving: boolean): void {
    const now = performance.now();
    if (now - this.lastBadge < 100) return;
    this.lastBadge = now;
    const pt = this.pt!;
    const max = this.photoRequest ? this.photoRequest.samples : this.settings.data.raytracing.maxSamples;
    const s = Math.floor(pt.samples);
    if (pt.compiling) this.rtText.textContent = 'Compiling path tracer shaders…';
    else if (moving) this.rtText.textContent = 'Live · pause to converge';
    else this.rtText.textContent = `${s} / ${max} samples`;
    this.rtBar.style.width = `${Math.min(100, (s / max) * 100)}%`;
  }
}
