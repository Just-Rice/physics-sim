import * as THREE from 'three';
import { SettingsStore, defaultSettings, RT_PRESETS, currentRtQuality, type RtQuality, type Settings } from './settings';
import type { AppContext, ParticleTools, PickResult } from './context';
import { History } from './history';
import { initRapier, RAPIER } from '../physics/RigidWorld';
import { Simulation } from '../sim/Simulation';
import { RasterRenderer } from '../render/RasterRenderer';
import { device } from './device';
import { PathTracer, pathTracingUnsupportedReason } from '../render/PathTracer';
import { Flashes, SelectionBox, Trails } from '../render/effects';
import { ModelLibrary } from '../models/library';
import { ThumbnailRenderer } from '../models/thumbnails';
import { registerProceduralAssets } from '../models/assets';
import type { ModelDef } from '../models/schema';
import type { Entity, PartInstance } from '../sim/types';
import { ToolManager } from '../tools/ToolManager';
import type { ToolPointer } from '../tools/Tool';
import { TopBar } from '../ui/TopBar';
import { LibraryPanel, MODEL_DRAG_TYPE } from '../ui/LibraryPanel';
import { BottomBar } from '../ui/BottomBar';
import { Inspector } from '../ui/Inspector';
import { SettingsPanel } from '../ui/SettingsPanel';
import { Toasts, confirmDialog, h, isTouch, prefs, svgIcon } from '../ui/dom';
import { icons } from '../ui/icons';
import { showHelp } from '../ui/help';
import { maybeShowWelcome, startTour, type TourStep } from '../ui/onboarding';
import { showScenePicker } from '../ui/ScenePicker';
import { SCENARIOS, type Scenario } from '../scenes/scenarios';
import { isSavedScene, resolveSavedModel, serializeScene, type SavedScene } from '../scenes/sceneIO';
import { detectPlatform, type MenuCommand, type Platform, type PickedFile } from '../platform';

export type ParticlesApi = ParticleTools & { count(): number; active(): boolean; reset(): void };

export interface AppExtensions {
  /** Particle physics plugin (cloth, soft bodies, fluids). */
  createParticles?(app: App): ParticlesApi | null;
  /** Model Builder mode. */
  createBuilder?(app: App): { enter(model?: ModelDef): void; exit(): void; update(dt: number): void; stopTest(): void; exportMenu(): void; readonly el: HTMLElement[] } | null;
  /** File import (meshes and model JSON). */
  importFiles?(app: App, files: PickedFile[], opts?: { silent?: boolean }): Promise<void>;
  /** Load stored mesh assets for the library. */
  assetLoader?: ModelLibrary['assetLoader'];
  exportModel?(app: App, model: ModelDef): Promise<void>;
}

const UNDO_LABELS: Record<string, string> = {
  add: 'adding objects',
  delete: 'delete',
  explode: 'explosion',
  attract: 'attract',
  grab: 'moving things',
  clear: 'clear',
  edit: 'edit',
  scene: 'scene change',
  reset: 'reset',
  duplicate: 'duplicate',
};

export class App implements AppContext {
  readonly settings: SettingsStore;
  readonly platform: Platform;
  readonly library = new ModelLibrary();
  readonly history = new History(30);
  view!: RasterRenderer;
  sim!: Simulation;
  particles: ParticlesApi | null = null;
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
  private rtStill!: HTMLButtonElement;
  private rtSave!: HTMLButtonElement;
  private rtQuality!: HTMLSelectElement;
  private hintEl!: HTMLElement;
  private hintText!: HTMLElement;
  /** Per-tool switches next to the hint (Attract: Pull / Push). */
  private toolOpts!: HTMLElement;
  private pausedEl!: HTMLElement;
  private timer = new THREE.Timer();
  private fps = 60;
  private photoRequest: { samples: number; resolve: () => void } | null = null;
  private lastMotion = 0;
  private lastStats = 0;
  private draggingModel: string | null = null;
  private softRestartNoted = false;
  /** What "Reset" returns to: a scenario, or the last scene file that was opened. */
  private resetPoint: SavedScene | null = null;
  private libraryWasOpen = true;
  private contextLost = false;
  private hintFadeTimer = 0;
  private adapt = { low: 0, high: 0, cooldown: 0 };
  /** The Builder's Test run is going: Play-style tools and time controls apply. */
  private builderTesting = false;
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
    } else if (device.mobile) {
      // Phones and tablets: lighter defaults so it stays smooth (and cool).
      const fast = RT_PRESETS.fast;
      Object.assign(s.raytracing, { bounces: fast.bounces, transmissiveBounces: fast.transmissiveBounces, renderScale: fast.renderScale, maxSamples: fast.maxSamples, liveRenderScale: 0.25 });
      if (device.phone) s.particles.maxParticles = 4000;
      s.particles.threads = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
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
    this.view = new RasterRenderer(viewport, this.settings, { lite: device.mobile });
    this.ptUnsupported = pathTracingUnsupportedReason(this.view.renderer);
    this.watchContextLoss();
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
    this.platform.onWatchedFile?.((f) => this.ext.importFiles?.(this, [f], { silent: true }));
    this.platform.watchFolder?.(false).then((folder) => {
      if (folder) this.toast(`Blender live link: watching ${folder.replace(/^\/Users\/[^/]+/, '~')}`);
    });
    document.addEventListener('physics-sim:build', () => this.setMode('build'));

    this.loadScenario('sandbox', false);
    // On a phone the library is a full-screen sheet: start with the scene visible.
    if (this.narrow) this.toggleLibrary(false);
    document.getElementById('boot')?.classList.add('hidden');
    setTimeout(() => document.getElementById('boot')?.remove(), 600);
    this.view.renderer.setAnimationLoop(() => this.frame());
    // Exposed for debugging and automated smoke tests.
    (window as unknown as { physicsApp: App }).physicsApp = this;
    if (!new URLSearchParams(location.search).has('notour')) setTimeout(() => maybeShowWelcome(() => this.tourSteps()), 700);
  }

  // ------------------------------------------------------------------ UI

  private buildUI(): void {
    const ui = document.getElementById('ui')!;
    this.topbar = new TopBar(this.tools, {
      onOpenScenes: () => this.openScenes(),
      onMode: (m) => this.setMode(m),
      onRayTracing: (on) => this.setRayTracing(on),
      onToggleSettings: () => this.toggleSettings(),
      onToggleLibrary: () => this.toggleLibrary(),
      onHelp: () => this.showHelp(),
    });
    if (this.ptUnsupported) this.topbar.setRayTracingUnavailable(this.ptUnsupported);

    this.libraryPanel = new LibraryPanel(this.library, this.thumbs, {
      onPick: (m) => this.armSpawn(m.id),
      onQuickAdd: (m) => this.dropInView(m.id),
      onImport: () => this.openImport(),
      onDelete: async (m) => {
        const ok = await confirmDialog(`Delete “${m.name}”?`, 'It will be removed from My models. Copies already in the scene stay until you clear them.', { confirm: 'Delete', danger: true });
        if (!ok) return;
        await this.library.deleteUserModel(m.id);
        this.toast(`Deleted ${m.name}`);
      },
      onEdit: (m) => {
        this.setMode('build');
        this.builder?.enter(m);
      },
      onExport: (m) => this.ext.exportModel?.(this, m),
      onClose: () => this.toggleLibrary(false),
    });
    this.libraryPanel.setActive(this.tools.spawn.modelId);
    this.libraryPanel.el.addEventListener('dragstart', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('.lib-card')?.dataset.id;
      this.draggingModel = id ?? null;
    });
    this.libraryPanel.el.addEventListener('dragend', () => {
      this.draggingModel = null;
      this.tools.spawn.hidePreview();
    });

    this.bottombar = new BottomBar(this.settings, {
      onTogglePause: () => this.togglePause(),
      onStep: () => this.stepOnce(),
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onReset: () => this.resetScene(),
      onClear: () => this.clearScene(),
      onPhoto: () => this.savePhoto(),
    });
    this.history.onChange(() => this.syncHistoryUi());

    this.inspector = new Inspector({
      onDelete: (p) => this.deleteEntity(p.entity),
      onDuplicate: (p) => this.duplicate(p.entity),
      onFocus: (p) => this.focusOn(p.object),
      onClose: () => this.select(null),
      onBeforeEdit: () => this.checkpoint('edit', 1200),
      onMaterialChanged: () => this.pt?.markMaterialsDirty(),
    });

    this.settingsPanel = new SettingsPanel(this.settings, {
      onWatchFolder: this.platform.watchFolder ? () => this.chooseWatchFolder() : undefined,
      onPhoto: () => this.savePhoto(),
      onClose: () => this.toggleSettings(false),
      onHelp: () => this.showHelp(),
    });

    // Ray-tracing status badge
    this.rtBar = h('i');
    this.rtText = h('span', { class: 'rt-text' });
    this.rtStill = h('button', { class: 'btn small', title: 'Pause and let the picture sharpen', onclick: () => this.renderStill() }, 'Render still');
    this.rtSave = h('button', { class: 'btn small', title: 'Save this picture (P)', onclick: () => this.savePhoto() }, svgIcon(icons.camera), 'Save');
    this.rtQuality = h('select', { class: 'select small', title: 'Ray-tracing quality', 'aria-label': 'Ray-tracing quality' },
      ...(Object.keys(RT_PRESETS) as RtQuality[]).map((k) => h('option', { value: k }, RT_PRESETS[k].label)),
      h('option', { value: 'custom', disabled: true }, 'Custom'));
    this.rtQuality.addEventListener('change', () => this.settings.applyRtQuality(this.rtQuality.value as RtQuality));
    this.rtQuality.addEventListener('keydown', (e) => e.stopPropagation());
    this.rtBadge = h('div', { class: 'rt-badge panel', role: 'status' }, this.rtText, h('div', { class: 'bar' }, this.rtBar), this.rtStill, this.rtSave, this.rtQuality);

    this.hintText = h('span', { class: 'hint-text' });
    const pullPush = (push: boolean, label: string) => h('button', {
      class: 'seg-btn', 'data-push': String(push),
      onclick: () => {
        this.tools.attract.push = push;
        this.updateHint();
      },
    }, label);
    this.toolOpts = h('div', { class: 'seg tool-opts', role: 'group', 'aria-label': 'Attract mode' }, pullPush(false, 'Pull'), pullPush(true, 'Push'));
    this.hintEl = h('div', { class: 'hint panel', role: 'status' }, this.hintText, this.toolOpts);
    this.pausedEl = h('button', { class: 'paused-pill panel', title: 'Resume (Space)', onclick: () => this.togglePause() },
      svgIcon(icons.play), h('span', {}, 'Paused'), h('span', { class: 'insp-sub' }, 'Space to resume'));

    const rightCol = h('div', { class: 'right-col' }, this.inspector.el, this.settingsPanel.el);
    ui.append(this.topbar.el, this.libraryPanel.el, this.bottombar.el, rightCol, this.rtBadge, this.pausedEl, this.hintEl, this.toasts.el,
      h('div', { class: 'drop-overlay', id: 'drop-overlay' }, 'Drop to import'));
    this.tools.onChange(() => this.updateHint());
    this.tools.onHover((info) => this.updateHint(info?.hint));
    this.updateHint();
    this.syncHistoryUi();
    this.syncPausedUi();
  }

  private tourSteps(): TourStep[] {
    const touch = isTouch();
    // On a phone the library is a full-screen sheet: close it again after its step.
    const closeSheet = () => {
      if (this.narrow) this.toggleLibrary(false);
    };
    return [
      { target: '.library', title: 'Add things', text: touch
        ? 'Tap a model, then tap where it should go. Hold a model for more options.'
        : 'Drag any model into the scene. Or click one, then click where it should go. Double-click drops it in the middle of the view.', before: () => this.toggleLibrary(true) },
      { target: '.toolbar', title: 'Tools', text: touch
        ? 'Hand grabs and throws (drag an object). Place puts down library models. Cannon fires, Explode blasts, Attract pulls, Erase removes.'
        : 'Hand grabs and throws (drag an object). Place puts down library models. Cannon fires, Explode blasts, Attract pulls, Erase removes. Keys 1–6 switch tools.', before: closeSheet },
      { target: '.scene-btn', title: 'Ready-made scenes', text: 'Dominoes, a dam break, flags in the wind, planets in orbit, a glass studio… pick one here.', before: closeSheet },
      { target: '.rt-toggle', title: 'Ray tracing', text: touch
        ? 'Realistic light: soft shadows, reflections and glass. It is grainy while things move; pause to let it sharpen. Heavy on phones.'
        : 'Realistic light: soft shadows, reflections and glass. It is grainy while things move; press Render still (or Space) to let it sharpen.' },
      { target: '.settings-btn', title: 'Settings', text: 'Change gravity (try the Moon or Orbits), wind, slow motion and the lighting. The detailed knobs are under Advanced.' },
      { target: '.bottombar', title: 'Time & undo', text: 'Pause, step a frame, slow motion — and Undo if you knock something over. Reset puts the scene back how it started.' },
      { target: '.mode-switch', title: 'Build your own', text: 'Build mode lets you join shapes with hinges, springs and motors, test them, and save them to your library.' },
    ];
  }

  private showHelp(): void {
    showHelp(this.platform.kind, () => startTour(this.tourSteps()));
  }

  private updateHint(override?: string): void {
    if (this.mode === 'build' && !this.builderTesting) {
      this.hintEl.style.display = 'none';
      return;
    }
    this.hintEl.style.display = '';
    const text = (this.tools.usingTouch ? undefined : override) ?? this.tools.hint;
    if (this.hintText.textContent !== text) {
      this.hintText.textContent = text;
      // Phones: the hint covers the scene, so it fades once it has been read.
      this.hintEl.classList.remove('faded');
      clearTimeout(this.hintFadeTimer);
      if (this.narrow) this.hintFadeTimer = window.setTimeout(() => this.hintEl.classList.add('faded'), 6000);
    }
    const attract = this.tools.active === this.tools.attract;
    this.hintEl.classList.toggle('has-opts', attract);
    for (const b of this.toolOpts.querySelectorAll<HTMLElement>('.seg-btn')) {
      const on = attract && (b.dataset.push === 'true') === this.tools.attract.push;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  toast(message: string, kind: 'info' | 'error' = 'info'): void {
    this.toasts.show(message, kind);
  }

  /** Phones (and short landscape windows): panels are sheets over the scene. */
  private get narrow(): boolean {
    return window.innerWidth <= 760 || window.innerHeight <= 500;
  }

  toggleSettings(force?: boolean): void {
    const open = force ?? !this.settingsPanel.isOpen;
    this.settingsPanel.setOpen(open);
    this.topbar.setSettingsOpen(open);
    if (open && this.narrow) this.toggleLibrary(false);
  }

  toggleLibrary(force?: boolean): void {
    const open = force ?? !this.libraryPanel.isOpen;
    this.libraryPanel.setOpen(open);
    this.topbar.setLibraryOpen(open);
    if (open && this.narrow && this.settingsPanel.isOpen) this.toggleSettings(false);
  }

  private bindSettings(): void {
    this.settings.on((p) => {
      if (p === 'render.trails') this.trails.setEnabled(this.settings.data.render.trails);
      if (p === 'raytracing.enabled') this.syncRayTracingUi();
      if (p === 'physics.paused') this.syncPausedUi();
      if (p.startsWith('raytracing.')) this.syncRtQualityUi();
    });
  }

  private bindKeys(): void {
    // Buttons and sliders keep focus after a mouse click, which would swallow
    // Space and the shortcut keys. Keyboard users still get normal focus.
    document.addEventListener('click', (e) => {
      if (e.detail === 0) return;
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('button, [role="button"]');
      if (el && el === document.activeElement) el.blur();
    });
    document.addEventListener('pointerup', (e) => {
      const el = e.target as HTMLInputElement | null;
      if (el?.tagName === 'INPUT' && el.type === 'range') setTimeout(() => el.blur(), 0);
    });
    window.addEventListener('keydown', (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      if (document.querySelector('.modal-back, .tour-layer')) return;
      const k = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey) {
        if (this.mode !== 'play') return; // the builder has its own shortcuts
        if (k === 's') {
          e.preventDefault();
          this.saveScene();
        } else if (k === 'o') {
          e.preventDefault();
          this.openImport();
        } else if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) this.redo();
          else this.undo();
        } else if (k === 'y') {
          e.preventDefault();
          this.redo();
        }
        return;
      }
      if (this.mode === 'build' && !this.builderTesting) {
        if (e.key === 'Escape') this.setMode('play');
        return;
      }
      if (this.builderTesting && e.key === 'Escape') {
        this.builder?.stopTest();
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
        case 'r': case 'R': this.resetScene(); break;
        case 't': case 'T': this.setRayTracing(!this.settings.data.raytracing.enabled); break;
        case 'b': case 'B': this.setMode('build'); break;
        case 'l': case 'L': this.toggleLibrary(); break;
        case 'g': case 'G': this.toggleSettings(); break;
        case 'f': case 'F': if (this.selected) this.focusOn(this.selected.object); break;
        case 'p': case 'P': this.savePhoto(); break;
        case 'h': case 'H': case '?': this.showHelp(); break;
        case 'Delete': case 'Backspace':
          e.preventDefault();
          if (e.shiftKey) this.clearScene();
          else if (this.selected) this.deleteEntity(this.selected.entity);
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
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      overlay()?.classList.add('visible');
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) {
        depth = 0;
        overlay()?.classList.remove('visible');
      }
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      overlay()?.classList.remove('visible');
      if (!hasFiles(e)) return;
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      const picked = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
      await this.handleFiles(picked);
    });

    // Library cards dragged onto the scene
    const canvas = this.view.renderer.domElement;
    const pointer = (e: DragEvent): ToolPointer => ({ x: e.clientX, y: e.clientY, button: 0, shift: e.shiftKey, alt: false });
    const isModel = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes(MODEL_DRAG_TYPE);
    canvas.addEventListener('dragover', (e) => {
      if (!isModel(e) || this.mode !== 'play') return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      if (this.draggingModel) this.tools.spawn.previewAt(pointer(e), this.draggingModel);
    });
    canvas.addEventListener('dragleave', () => this.tools.spawn.hidePreview());
    canvas.addEventListener('drop', (e) => {
      if (!isModel(e) || this.mode !== 'play') return;
      e.preventDefault();
      e.stopPropagation();
      const id = e.dataTransfer!.getData(MODEL_DRAG_TYPE) || this.draggingModel;
      this.tools.spawn.hidePreview();
      this.draggingModel = null;
      if (!id) return;
      if (!this.tools.spawn.placeAt(pointer(e), id)) this.toast('Drop it on the floor or on an object', 'error');
    });
  }

  private async handleFiles(files: PickedFile[]): Promise<void> {
    if (this.mode === 'build') this.setMode('play');
    // A saved scene?
    if (files.length === 1 && /\.json$/i.test(files[0].name)) {
      try {
        const json = JSON.parse(new TextDecoder().decode(files[0].bytes));
        if (isSavedScene(json)) {
          this.checkpoint('scene');
          this.applySavedScene(json);
          this.resetPoint = json;
          this.topbar.setScene(files[0].name.replace(/\.json$/i, ''));
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
    // Commands that replace the scene belong to Play mode; the Builder would
    // otherwise restore its stashed scene over them on exit.
    if (this.mode === 'build' && (cmd === 'reset' || cmd === 'load-scene' || cmd === 'open' || cmd === 'save-scene' || cmd === 'render-photo')) this.setMode('play');
    switch (cmd) {
      case 'open': this.openImport(); break;
      case 'save-scene': this.saveScene(); break;
      case 'load-scene': this.loadSceneFile(); break;
      case 'render-photo': this.savePhoto(); break;
      case 'toggle-raytracing': this.setRayTracing(!this.settings.data.raytracing.enabled); break;
      case 'toggle-pause': this.togglePause(); break;
      case 'step': if (this.mode === 'play') this.stepOnce(); break;
      case 'reset': this.resetScene(); break;
      case 'help': this.showHelp(); break;
      case 'watch-folder': this.chooseWatchFolder(); break;
      case 'build-mode': this.setMode('build'); break;
      case 'play-mode': this.setMode('play'); break;
      case 'export-model':
        if (this.mode === 'build') this.builder?.exportMenu();
        else this.toast('Open Build mode (B) to export a model');
        break;
    }
  }

  // ------------------------------------------------------------------ library actions

  /** Click a library card: the Place tool now drops that model. */
  private armSpawn(id: string): void {
    this.tools.spawn.modelId = id;
    this.tools.setTool('spawn');
    this.libraryPanel.setActive(id);
    this.updateHint();
    if (this.narrow) this.toggleLibrary(false);
  }

  /** Double-click a card: drop the model where the camera is looking. */
  private dropInView(id: string): void {
    if (this.mode !== 'play') return;
    const rect = this.view.renderer.domElement.getBoundingClientRect();
    const p: ToolPointer = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, button: 0, shift: false, alt: false };
    if (!this.tools.spawn.placeAt(p, id)) {
      const t = this.view.controls.target;
      this.spawnModel(id, new THREE.Vector3(t.x, Math.max(0.5, t.y), t.z));
    }
    this.libraryPanel.setActive(id);
    this.tools.spawn.modelId = id;
  }

  private duplicate(e: Entity): void {
    const first = e.parts[0];
    let pos: THREE.Vector3;
    if (first) {
      const t = first.body.translation();
      const d = first.def.position;
      pos = new THREE.Vector3(t.x - d[0], t.y - d[1], t.z - d[2]);
    } else {
      pos = new THREE.Vector3(...e.placement.position);
    }
    // Side-step to the camera's right so the copy isn't inside the original.
    const right = new THREE.Vector3().setFromMatrixColumn(this.view.camera.matrixWorld, 0).setY(0).normalize();
    const box = new THREE.Box3();
    for (const p of e.parts) box.expandByObject(p.object);
    const w = box.isEmpty() ? 0.6 : Math.max(0.3, box.getSize(new THREE.Vector3()).length() * 0.6);
    pos.addScaledVector(right, w);
    pos.y += 0.05;
    this.checkpoint('duplicate');
    const copy = this.spawnModel(e.model, pos, { yaw: e.placement.rotation[1], record: false });
    if (copy?.parts[0]) this.select(copy.parts[0]);
  }

  // ------------------------------------------------------------------ undo / redo

  private snapshot(): SavedScene {
    return serializeScene(this.sim, this.library, this.settings.data, this.view.camera, this.view.controls.target, this.view.ground.visible);
  }

  checkpoint(label: string, coalesceMs = 0): void {
    if (this.mode !== 'play' || !this.sim) return;
    this.history.record(label, () => this.snapshot(), coalesceMs);
  }

  undo(): void {
    if (this.mode !== 'play') return;
    const e = this.history.undo(() => this.snapshot());
    if (!e) {
      this.toast('Nothing to undo');
      return;
    }
    this.restore(e.scene);
    this.toast(`Undid ${UNDO_LABELS[e.label] ?? e.label}`);
  }

  redo(): void {
    if (this.mode !== 'play') return;
    const e = this.history.redo(() => this.snapshot());
    if (!e) {
      this.toast('Nothing to redo');
      return;
    }
    this.restore(e.scene);
    this.toast(`Redid ${UNDO_LABELS[e.label] ?? e.label}`);
  }

  private restore(scene: SavedScene): void {
    this.applySavedScene(scene, { quiet: true, keepCamera: true, keepSettings: true });
    if (!this.softRestartNoted && this.sim.entities.some((en) => en.model.softParts.length)) {
      this.softRestartNoted = true;
      this.toast('Cloth, jelly and water start again from where they were placed');
    }
  }

  private syncHistoryUi(): void {
    this.bottombar?.setHistory(this.history.canUndo, this.history.canRedo,
      this.history.undoLabel ? UNDO_LABELS[this.history.undoLabel] : null,
      this.history.redoLabel ? UNDO_LABELS[this.history.redoLabel] : null);
  }

  // ------------------------------------------------------------------ simulation control

  /** Called by the Builder when its Test run starts and stops. */
  setBuilderTesting(on: boolean): void {
    this.builderTesting = on;
    document.getElementById('ui')?.classList.toggle('testing', on);
    this.topbar.setToolbarVisible(this.mode === 'play' || on);
    if (!on) this.tools.setTool('hand');
    this.updateHint();
  }

  togglePause(): void {
    this.settings.set('physics', 'paused', !this.settings.data.physics.paused);
  }

  private syncPausedUi(): void {
    if (!this.pausedEl) return;
    this.pausedEl.classList.toggle('visible', this.settings.data.physics.paused && this.mode === 'play' && !this.photoRequest);
  }

  stepOnce(): void {
    if (!this.settings.data.physics.paused) this.settings.set('physics', 'paused', true);
    this.sim.stepManual();
    this.pt?.markSceneDirty();
  }

  clearScene(): void {
    if (this.mode !== 'play') return;
    const n = this.sim.entities.filter((e) => !e.locked).length;
    if (n === 0) return;
    this.checkpoint('clear');
    this.tools.cancel();
    this.select(null);
    this.sim.clear();
    this.particles?.reset();
    this.trails.clear();
    this.tools.clearHighlight();
    this.pt?.markSceneDirty();
    this.toast('Cleared — Ctrl/⌘ + Z to bring it back');
  }

  /** Back to how the scene started (the scenario, or the scene file that was opened). */
  resetScene(): void {
    if (this.mode !== 'play') return;
    this.checkpoint('reset');
    if (this.resetPoint) this.applySavedScene(this.resetPoint, { quiet: true });
    else this.loadScenario(this.scenario.id, false);
  }

  openScenes(): void {
    showScenePicker(this.scenario.id, (id) => this.loadScenario(id), {
      onLoadFile: () => this.loadSceneFile(),
      onSaveFile: () => this.saveScene(),
    });
  }

  loadScenario(id: string, record = true): void {
    if (this.mode === 'build') this.setMode('play');
    if (record) this.checkpoint('scene');
    const sc = SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
    this.scenario = sc;
    this.resetPoint = null;
    this.topbar.setScene(sc.name);
    this.tools.cancel();
    this.select(null);
    this.sim.clear();
    this.particles?.reset();
    this.trails.clear();
    this.tools.clearHighlight();

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
    document.getElementById('ui')?.classList.toggle('building', mode === 'build');
    this.select(null);
    if (mode === 'build') {
      this.tools.setTool('hand');
      this.tools.enabled = false;
      this.libraryWasOpen = this.libraryPanel.isOpen;
      this.libraryPanel.setOpen(false);
      this.topbar.setLibraryOpen(false);
      this.sim.root.visible = false;
      this.particles?.pickables().forEach((o) => (o.visible = false));
      this.builder!.enter();
    } else {
      this.builder?.exit();
      this.tools.enabled = true;
      this.sim.root.visible = true;
      this.particles?.pickables().forEach((o) => (o.visible = true));
      if (this.libraryWasOpen && !this.narrow) {
        this.libraryPanel.setOpen(true);
        this.topbar.setLibraryOpen(true);
      }
    }
    this.updateHint();
    this.syncPausedUi();
    this.pt?.markSceneDirty();
  }

  // ------------------------------------------------------------------ AppContext

  select(part: PartInstance | null): void {
    this.selected = part;
    this.selectionBox.part = part;
    this.inspector.show(part);
    this.pt?.requestPresent();
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
        soft: isGround ? null : this.particles?.softFromObject(hit.object, hit.point) ?? null,
        object: hit.object,
        isGround,
      };
    }
    // Fall back to the ground plane even if it is hidden (space scenes) so placing still works.
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pt = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (pt && pt.distanceTo(this.view.camera.position) < 200) {
      return { point: pt, normal: new THREE.Vector3(0, 1, 0), distance: pt.distanceTo(this.view.camera.position), part: null, soft: null, object: this.view.ground, isGround: true };
    }
    return null;
  }

  spawnModel(modelOrId: ModelDef | string, position: THREE.Vector3, opts: { yaw?: number; velocity?: THREE.Vector3; record?: boolean } = {}): Entity | null {
    const model = typeof modelOrId === 'string' ? this.library.get(modelOrId) : modelOrId;
    if (!model) {
      this.toast(`Unknown model ${String(modelOrId)}`, 'error');
      return null;
    }
    const limit = 2500;
    if (this.sim.parts.length + model.parts.length > limit) {
      this.toast(`That's a lot of objects (limit ${limit}). Clear some first.`, 'error');
      return null;
    }
    if (opts.record !== false) this.checkpoint('add', 800);
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

  /** Swap every placed copy of a model for its new definition (hot reload). */
  replaceModelInstances(model: ModelDef): void {
    const olds = this.sim.entities.filter((e) => e.model.id === model.id);
    for (const e of olds) {
      const placement = { ...e.placement };
      const first = e.parts[0];
      if (first) {
        // Keep it roughly where it is now.
        const t = first.body.translation();
        const d = first.def.position;
        placement.position = [t.x - d[0], t.y - d[1], t.z - d[2]];
      }
      this.removeEntity(e);
      this.sim.spawn(model, { ...placement, model: model.id });
    }
    if (olds.length) {
      this.sim.sync(1);
      this.pt?.markSceneDirty();
      this.pt?.markMaterialsDirty();
    }
  }

  removeEntity(e: Entity): void {
    if (e.locked) return;
    if (this.selected?.entity === e) this.select(null);
    this.sim.remove(e);
    this.tools?.clearHighlight();
    this.pt?.markSceneDirty();
  }

  deleteEntity(e: Entity): void {
    if (e.locked) return;
    this.checkpoint('delete', 400);
    this.removeEntity(e);
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
        this.toast('Could not start the ray tracer', 'error');
        this.topbar.setRayTracing(false);
        this.ptLoading = false;
        return;
      }
      this.ptLoading = false;
    }
    // The path tracer works from the canvas size: give it full resolution.
    if (on) this.view.setPixelRatio(this.view.maxPixelRatio);
    this.settings.set('raytracing', 'enabled', on);
    this.pt?.markSceneDirty();
    this.pt?.markMaterialsDirty();
    this.pt?.markEnvironmentDirty();
    this.pt?.reset();
    this.syncRayTracingUi();
    if (on && device.mobile && !prefs.get('rt-mobile-note')) {
      prefs.set('rt-mobile-note', '1');
      this.toast('Ray tracing is heavy on phones: Fast quality is picked, and it may run warm. Pause for a sharp picture.');
    } else if (on) {
      this.toast(isTouch() ? 'Ray tracing on — pause for a sharp picture' : 'Ray tracing on — press Render still (or Space) for a sharp picture');
    }
  }

  /** Pause and let the ray tracer converge. */
  renderStill(): void {
    if (!this.settings.data.physics.paused) this.settings.set('physics', 'paused', true);
    this.pt?.requestPresent();
  }

  private syncRayTracingUi(): void {
    const on = this.settings.data.raytracing.enabled && !!this.pt;
    this.topbar.setRayTracing(on);
    this.rtBadge.classList.toggle('visible', on);
    this.syncRtQualityUi();
  }

  private syncRtQualityUi(): void {
    if (!this.rtQuality) return;
    this.rtQuality.value = currentRtQuality(this.settings.data) ?? 'custom';
  }

  // ------------------------------------------------------------------ files

  async saveScene(): Promise<void> {
    const data = this.snapshot();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const ok = await this.platform.saveFile(`${this.scenario.id}-scene.json`, blob);
    if (ok) this.toast('Scene saved');
  }

  async loadSceneFile(): Promise<void> {
    const files = await this.platform.openFiles({ accept: ['.json'] });
    if (files.length) await this.handleFiles(files);
  }

  applySavedScene(scene: SavedScene, opts: boolean | { quiet?: boolean; keepCamera?: boolean; keepSettings?: boolean } = false): void {
    const o = typeof opts === 'boolean' ? { quiet: opts } : opts;
    this.tools?.cancel(); // let go of anything held: its body is about to go
    this.select(null);
    this.sim.clear();
    this.particles?.reset();
    this.trails.clear();
    this.tools?.clearHighlight();
    if (!o.keepSettings) {
      for (const [k, v] of Object.entries(scene.physics)) this.settings.set('physics', k as keyof Settings['physics'], v as never);
      for (const [k, v] of Object.entries(scene.render)) this.settings.set('render', k as keyof Settings['render'], v as never);
    }
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
      if (typeof e.model !== 'string' && !this.library.builtin.some((b) => b.id === model.id)) ent.ownModel = true;
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
    if (!o.keepCamera) {
      this.view.camera.position.set(...scene.camera.position);
      this.view.controls.target.set(...scene.camera.target);
      this.view.controls.update();
    }
    this.pt?.markSceneDirty();
    this.pt?.markMaterialsDirty();
    if (!o.quiet || missing) this.toast(missing ? `Scene loaded (${missing} model(s) missing from your library)` : 'Scene loaded', missing ? 'error' : 'info');
  }

  async savePhoto(): Promise<void> {
    if (this.photoRequest) return;
    const rt = this.settings.data.raytracing.enabled && this.pt;
    if (rt) {
      const wasPaused = this.settings.data.physics.paused;
      this.settings.set('physics', 'paused', true);
      // Keep the samples already gathered if the picture was converging anyway.
      const already = this.pt!.samples;
      this.pt!.photoMode = true;
      const target = Math.min(this.settings.data.raytracing.maxSamples, 400);
      if (already < target) this.toast(`Rendering ${target} samples…`);
      await new Promise<void>((resolve) => (this.photoRequest = { samples: target, resolve }));
      this.pt!.photoMode = false;
      if (!wasPaused) this.settings.set('physics', 'paused', false);
    } else {
      await new Promise<void>((resolve) => (this.photoRequest = { samples: 0, resolve }));
    }
    this.syncPausedUi();
  }

  private capturePhoto(): void {
    const canvas = this.view.renderer.domElement;
    const req = this.photoRequest!;
    this.photoRequest = null;
    canvas.toBlob(async (blob) => {
      if (blob) {
        const name = `physics-sim-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        const ok = await this.platform.saveFile(name, blob);
        if (ok) this.toast('Picture saved');
      } else {
        this.toast('Could not capture the picture', 'error');
      }
      req.resolve();
    }, 'image/png');
  }

  // ------------------------------------------------------------------ frame loop

  /** Tools + physics for one animation frame (also used by the builder's test run). */
  simulateFrame(dt: number): void {
    this.tools.update(dt);
    const before = this.sim.stepCount;
    const alpha = this.sim.advance(dt);
    this.sim.sync(alpha);
    const stepped = this.sim.stepCount !== before;
    if (stepped && this.anyMotion()) this.lastMotion = performance.now();
    if (stepped) this.pt?.markSceneDirty();
  }

  private anyMotion(): boolean {
    for (const p of this.sim.parts) {
      if (p.body.isDynamic() && !p.body.isSleeping()) return true;
    }
    return this.particles?.active() ?? false;
  }

  /**
   * Mobile browsers drop the WebGL context when a tab is backgrounded or
   * memory runs low. three.js restores its own state; the ray tracer is
   * rebuilt on demand.
   */
  private watchContextLoss(): void {
    const canvas = this.view.renderer.domElement;
    canvas.addEventListener('webglcontextlost', () => {
      this.contextLost = true;
      if (this.settings.data.raytracing.enabled) this.settings.set('raytracing', 'enabled', false);
      this.pt?.dispose();
      this.pt = null;
      this.syncRayTracingUi();
      this.toast('Graphics were reset by the browser — back in a moment');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.toast('Graphics are back');
    });
  }

  /**
   * Adaptive resolution: render fewer pixels while the device can't hold
   * ~40 fps, and go back up once it has headroom. Off while ray tracing
   * (its own resolution setting covers that).
   */
  private adaptResolution(dt: number): void {
    const a = this.adapt;
    a.cooldown = Math.max(0, a.cooldown - dt);
    if (this.settings.data.raytracing.enabled || document.hidden || this.contextLost) {
      a.low = a.high = 0;
      return;
    }
    if (this.fps < 40) {
      a.low += dt;
      a.high = 0;
    } else if (this.fps > 57) {
      a.high += dt;
      a.low = 0;
    } else {
      a.low = a.high = 0;
    }
    const r = this.view.pixelRatio;
    if (a.low > 2 && r > Math.min(1, this.view.maxPixelRatio)) {
      this.view.setPixelRatio(r - 0.25);
      a.low = 0;
      a.cooldown = 20; // don't bounce straight back up
    } else if (a.high > 5 && a.cooldown === 0 && r < this.view.maxPixelRatio) {
      this.view.setPixelRatio(r + 0.25);
      a.high = 0;
    }
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
    this.adaptResolution(dt);

    if (this.mode === 'play') this.simulateFrame(dt);
    else this.builder?.update(dt);

    this.view.controls.update();
    this.flashes.update(dt);
    this.selectionBox.update();
    this.inspector.update();

    const rtOn = this.settings.data.raytracing.enabled && this.pt;
    if (rtOn) {
      const moving = !this.settings.data.physics.paused && performance.now() - this.lastMotion < 250;
      if (this.pt!.render(moving)) {
        // Tool helpers (selection box, grab line, gizmos) are drawn on top of the traced image.
        const r = this.view.renderer;
        const autoClear = r.autoClear;
        r.autoClear = false;
        r.clearDepth();
        r.render(this.view.helpers, this.view.camera);
        r.autoClear = autoClear;
      }
      this.updateRtBadge(moving);
    } else {
      this.view.render();
    }

    if (this.photoRequest && (!rtOn || this.pt!.samples >= this.photoRequest.samples)) this.capturePhoto();

    // Stats are for humans: 4 updates a second is plenty.
    const now = performance.now();
    if (now - this.lastStats > 250) {
      this.lastStats = now;
      const st = this.sim.stats();
      this.bottombar.setStats({ fps: this.fps, bodies: st.bodies, particles: this.particles?.count() ?? 0, kinetic: st.kinetic });
    }
  }

  private lastBadge = 0;
  private updateRtBadge(moving: boolean): void {
    const now = performance.now();
    if (now - this.lastBadge < 100) return;
    this.lastBadge = now;
    const pt = this.pt!;
    const max = this.photoRequest ? this.photoRequest.samples : this.settings.data.raytracing.maxSamples;
    const s = Math.floor(pt.samples);
    let text: string;
    if (pt.compiling) text = 'Preparing the ray tracer…';
    else if (this.photoRequest) text = `Rendering picture… ${s} / ${max}`;
    else if (moving) text = 'Moving — preview quality';
    else if (s >= max) text = `Done · ${max} samples`;
    else text = `Sharpening… ${s} / ${max}`;
    if (this.rtText.textContent !== text) this.rtText.textContent = text;
    this.rtBar.style.width = `${moving ? 0 : Math.min(100, (s / max) * 100)}%`;
    this.rtStill.style.display = moving && !this.settings.data.physics.paused ? '' : 'none';
    this.rtSave.classList.toggle('primary', !moving && s >= max);
  }
}
