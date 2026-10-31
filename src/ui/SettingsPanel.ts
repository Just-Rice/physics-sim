import GUI, { type Controller } from 'lil-gui';
import { GRAVITY_PRESETS, type Settings, type SettingsStore } from '../app/settings';

/** lil-gui panel bound to the settings store. */
export class SettingsPanel {
  readonly el: HTMLElement;
  readonly gui: GUI;
  private controllers: Controller[] = [];
  extraActions: Record<string, () => void> = {};

  constructor(private store: SettingsStore, actions: { onWatchFolder?: () => void; onPhoto: () => void; onSaveScene: () => void; onLoadScene: () => void }) {
    this.el = document.createElement('div');
    this.el.className = 'settings-host hidden';
    this.gui = new GUI({ container: this.el, title: 'Settings', width: 300 });
    this.gui.domElement.addEventListener('keydown', (e) => e.stopPropagation());
    const s = store.data;

    const bind = <K extends keyof Settings>(folder: GUI, group: K, field: keyof Settings[K] & string, ...args: unknown[]) => {
      const c = (folder.add as (o: object, p: string, ...a: unknown[]) => Controller)(s[group] as object, field, ...args);
      c.onChange(() => store.emit(`${String(group)}.${field}`));
      this.controllers.push(c);
      return c;
    };

    const sim = this.gui.addFolder('Simulation');
    bind(sim, 'physics', 'timeScale', 0.05, 2, 0.01).name('Time scale');
    bind(sim, 'physics', 'solverIterations', 1, 16, 1).name('Solver iterations');
    sim.add({ save: actions.onSaveScene }, 'save').name('Save scene…');
    sim.add({ load: actions.onLoadScene }, 'load').name('Load scene…');

    const grav = this.gui.addFolder('Gravity');
    bind(grav, 'physics', 'gravityMode', { 'Uniform (down)': 'uniform', 'N-body (everything attracts)': 'nbody', 'Attractors only': 'attractors' }).name('Mode');
    const preset = bind(grav, 'physics', 'gravityPreset', Object.keys(GRAVITY_PRESETS)).name('Planet');
    preset.onChange((v: string) => {
      store.data.physics.gravity = GRAVITY_PRESETS[v] ?? 9.81;
      store.emit('physics.gravity');
      this.refresh();
    });
    bind(grav, 'physics', 'gravity', -5, 30, 0.01).name('Strength (m/s²)');
    bind(grav, 'physics', 'G', 0, 10, 0.01).name('G (n-body ×)');

    const air = this.gui.addFolder('Wind & air');
    bind(air, 'physics', 'windX', -20, 20, 0.1).name('Wind X (m/s)');
    bind(air, 'physics', 'windZ', -20, 20, 0.1).name('Wind Z (m/s)');
    bind(air, 'physics', 'windGust', 0, 1, 0.01).name('Gustiness');
    bind(air, 'physics', 'airDrag').name('Air drag');
    bind(air, 'physics', 'airDensity', 0, 5, 0.01).name('Air density');
    air.close();

    const part = this.gui.addFolder('Cloth, soft bodies & fluids');
    bind(part, 'particles', 'substeps', 1, 8, 1).name('Substeps');
    bind(part, 'particles', 'fluidIterations', 1, 6, 1).name('Fluid iterations');
    bind(part, 'particles', 'fluidRadius', 0.02, 0.08, 0.005).name('Fluid particle size');
    bind(part, 'particles', 'maxParticles', 1000, 40000, 500).name('Max particles');
    bind(part, 'particles', 'fluidRender', { 'Smooth surface': 'surface', Spheres: 'spheres' }).name('Water look');
    bind(part, 'particles', 'threads', 0, 16, 1).name('Threads (0 = auto)');
    part.close();

    const rend = this.gui.addFolder('Rendering');
    bind(rend, 'render', 'environment', { 'Sunny day': 'day', 'Golden hour': 'golden', Studio: 'studio', Night: 'night' }).name('Environment');
    bind(rend, 'render', 'sunElevation', 2, 89, 1).name('Sun elevation');
    bind(rend, 'render', 'sunAzimuth', 0, 360, 1).name('Sun direction');
    bind(rend, 'render', 'exposure', 0.1, 3, 0.01).name('Exposure');
    bind(rend, 'render', 'shadows').name('Shadows');
    bind(rend, 'render', 'showGrid').name('Grid floor');
    bind(rend, 'render', 'trails').name('Motion trails');
    rend.close();

    const rt = this.gui.addFolder('Ray tracing');
    bind(rt, 'raytracing', 'bounces', 1, 20, 1).name('Bounces');
    bind(rt, 'raytracing', 'transmissiveBounces', 1, 30, 1).name('Glass bounces');
    bind(rt, 'raytracing', 'renderScale', 0.25, 2, 0.05).name('Resolution (still)');
    bind(rt, 'raytracing', 'liveRenderScale', 0.1, 1, 0.05).name('Resolution (moving)');
    bind(rt, 'raytracing', 'maxSamples', 16, 10000, 1).name('Max samples');
    bind(rt, 'raytracing', 'filterGlossy', 0, 1, 0.01).name('Glossy filter');
    bind(rt, 'raytracing', 'denoise').name('Denoise');
    bind(rt, 'raytracing', 'denoiseStrength', 0, 3, 0.05).name('Denoise strength');
    bind(rt, 'raytracing', 'dof').name('Depth of field');
    bind(rt, 'raytracing', 'fStop', 0.3, 22, 0.1).name('f-stop');
    bind(rt, 'raytracing', 'focusDistance', 0.2, 60, 0.05).name('Focus distance');
    bind(rt, 'raytracing', 'apertureBlades', 0, 10, 1).name('Aperture blades');
    bind(rt, 'raytracing', 'liveUpdateRate', 1, 60, 1).name('Live updates / s');
    rt.add({ photo: actions.onPhoto }, 'photo').name('Render photo…');
    rt.close();

    const tools = this.gui.addFolder('Tools');
    bind(tools, 'tools', 'cannonModel', { 'Steel ball': 'steel-ball', 'Rubber ball': 'rubber-ball', 'Bowling ball': 'bowling-ball', 'Glass sphere': 'glass-sphere', Crate: 'crate', 'Jelly ball': 'jelly-sphere', 'Water block': 'water-block' }).name('Cannon fires');
    bind(tools, 'tools', 'cannonSpeed', 2, 80, 1).name('Cannon speed');
    bind(tools, 'tools', 'explodeStrength', 2, 150, 1).name('Explosion strength');
    bind(tools, 'tools', 'explodeRadius', 0.5, 15, 0.1).name('Explosion radius');
    bind(tools, 'tools', 'attractStrength', 5, 300, 1).name('Attract strength');
    bind(tools, 'tools', 'grabStrength', 0.1, 4, 0.05).name('Grab stiffness');
    tools.close();

    if (actions.onWatchFolder) {
      const desk = this.gui.addFolder('Blender live link');
      desk.add({ watch: actions.onWatchFolder }, 'watch').name('Choose watch folder…');
      desk.close();
    }

    store.on(() => this.refresh());
  }

  refresh(): void {
    for (const c of this.controllers) c.updateDisplay();
  }

  setOpen(open: boolean): void {
    this.el.classList.toggle('hidden', !open);
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }
}
