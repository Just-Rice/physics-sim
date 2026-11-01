import GUI, { type Controller } from 'lil-gui';
import { GRAVITY_PRESETS, type Settings, type SettingsStore } from '../app/settings';
import { QuickSettings } from './QuickSettings';
import { h, svgIcon } from './dom';
import { icons } from './icons';

/** Quick settings on top, every knob in a collapsed "Advanced" lil-gui panel below. */
export class SettingsPanel {
  readonly el: HTMLElement;
  readonly gui: GUI;
  readonly quick: QuickSettings;
  private controllers: Controller[] = [];
  /** Controllers that only make sense in some states. */
  private contextual: { c: Controller; when: (s: Settings) => boolean }[] = [];

  constructor(private store: SettingsStore, actions: { onWatchFolder?: () => void; onPhoto: () => void; onClose: () => void; onHelp: () => void }) {
    this.quick = new QuickSettings(store);
    const guiHost = h('div', { class: 'advanced-host' });
    this.el = h('div', { class: 'settings-host hidden', 'aria-label': 'Settings' },
      h('div', { class: 'settings-head' }, h('span', { style: 'flex:1' }, 'Settings'),
        h('button', { class: 'icon-btn sheet-help', title: 'Help', 'aria-label': 'Help', onclick: () => actions.onHelp() }, svgIcon(icons.help)),
        h('button', { class: 'icon-btn sheet-close', title: 'Close (G)', 'aria-label': 'Close settings', onclick: () => actions.onClose() }, svgIcon(icons.close))),
      this.quick.el,
      guiHost);
    this.gui = new GUI({ container: guiHost, title: 'Advanced', width: 300 });
    this.gui.domElement.addEventListener('keydown', (e) => e.stopPropagation());
    const s = store.data;

    const bind = <K extends keyof Settings>(folder: GUI, group: K, field: keyof Settings[K] & string, ...args: unknown[]) => {
      const c = (folder.add as (o: object, p: string, ...a: unknown[]) => Controller)(s[group] as object, field, ...args);
      c.onChange(() => store.emit(`${String(group)}.${field}`));
      this.controllers.push(c);
      return c;
    };
    const when = (c: Controller, fn: (s: Settings) => boolean) => {
      this.contextual.push({ c, when: fn });
      return c;
    };

    const sim = this.gui.addFolder('Simulation');
    bind(sim, 'physics', 'timeScale', 0.05, 2, 0.01).name('Time scale');
    bind(sim, 'physics', 'solverIterations', 1, 16, 1).name('Solver accuracy');

    const grav = this.gui.addFolder('Gravity');
    bind(grav, 'physics', 'gravityMode', { 'Down, like on a planet': 'uniform', 'Everything attracts (orbits)': 'nbody', 'Only attractor bodies pull': 'attractors' }).name('Mode');
    const preset = when(bind(grav, 'physics', 'gravityPreset', Object.keys(GRAVITY_PRESETS)).name('Planet'), (d) => d.physics.gravityMode === 'uniform');
    preset.onChange((v: string) => {
      store.data.physics.gravity = GRAVITY_PRESETS[v] ?? 9.81;
      store.emit('physics.gravity');
      this.refresh();
    });
    when(bind(grav, 'physics', 'gravity', -5, 30, 0.01).name('Strength (m/s²)'), (d) => d.physics.gravityMode === 'uniform');
    when(bind(grav, 'physics', 'G', 0, 10, 0.01).name('Pull strength ×'), (d) => d.physics.gravityMode !== 'uniform');

    const air = this.gui.addFolder('Wind & air');
    bind(air, 'physics', 'windX', -20, 20, 0.1).name('Wind X (m/s)');
    bind(air, 'physics', 'windZ', -20, 20, 0.1).name('Wind Z (m/s)');
    bind(air, 'physics', 'windGust', 0, 1, 0.01).name('Gustiness');
    bind(air, 'physics', 'airDrag').name('Air drag');
    when(bind(air, 'physics', 'airDensity', 0, 5, 0.01).name('Air density'), (d) => d.physics.airDrag);
    air.close();

    const part = this.gui.addFolder('Cloth, jelly & water');
    bind(part, 'particles', 'substeps', 1, 8, 1).name('Substeps');
    bind(part, 'particles', 'fluidIterations', 1, 6, 1).name('Water stiffness');
    bind(part, 'particles', 'fluidRadius', 0.02, 0.08, 0.005).name('Water droplet size');
    bind(part, 'particles', 'maxParticles', 1000, 40000, 500).name('Max particles');
    bind(part, 'particles', 'fluidRender', { 'Smooth surface': 'surface', Spheres: 'spheres' }).name('Water look');
    bind(part, 'particles', 'threads', 0, 16, 1).name('CPU threads (0 = auto)');
    part.close();

    const rend = this.gui.addFolder('Lighting & display');
    bind(rend, 'render', 'environment', { 'Sunny day': 'day', 'Golden hour': 'golden', Studio: 'studio', Night: 'night' }).name('Environment');
    when(bind(rend, 'render', 'sunElevation', 2, 89, 1).name('Sun height'), (d) => d.render.environment !== 'studio');
    when(bind(rend, 'render', 'sunAzimuth', 0, 360, 1).name('Sun direction'), (d) => d.render.environment !== 'studio');
    bind(rend, 'render', 'exposure', 0.1, 3, 0.01).name('Brightness');
    bind(rend, 'render', 'shadows').name('Shadows');
    bind(rend, 'render', 'showGrid').name('Grid floor');
    bind(rend, 'render', 'trails').name('Motion trails');
    rend.close();

    const rt = this.gui.addFolder('Ray tracing');
    bind(rt, 'raytracing', 'bounces', 1, 20, 1).name('Light bounces');
    bind(rt, 'raytracing', 'transmissiveBounces', 1, 30, 1).name('Glass bounces');
    bind(rt, 'raytracing', 'renderScale', 0.25, 2, 0.05).name('Resolution (still)');
    bind(rt, 'raytracing', 'liveRenderScale', 0.1, 1, 0.05).name('Resolution (moving)');
    bind(rt, 'raytracing', 'maxSamples', 16, 10000, 1).name('Max samples');
    bind(rt, 'raytracing', 'filterGlossy', 0, 1, 0.01).name('Glossy filter');
    bind(rt, 'raytracing', 'denoise').name('Denoise');
    when(bind(rt, 'raytracing', 'denoiseStrength', 0, 3, 0.05).name('Denoise strength'), (d) => d.raytracing.denoise);
    bind(rt, 'raytracing', 'dof').name('Depth of field');
    when(bind(rt, 'raytracing', 'fStop', 0.3, 22, 0.1).name('f-stop (blur)'), (d) => d.raytracing.dof);
    when(bind(rt, 'raytracing', 'focusDistance', 0.2, 60, 0.05).name('Focus distance (double-click to set)'), (d) => d.raytracing.dof);
    when(bind(rt, 'raytracing', 'apertureBlades', 0, 10, 1).name('Aperture blades'), (d) => d.raytracing.dof);
    bind(rt, 'raytracing', 'liveUpdateRate', 1, 60, 1).name('Live updates / s');
    rt.add({ photo: actions.onPhoto }, 'photo').name('Render photo…');
    rt.close();

    const tools = this.gui.addFolder('Tools');
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

    this.gui.close();
    store.on(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    for (const c of this.controllers) c.updateDisplay();
    for (const { c, when } of this.contextual) c.show(when(this.store.data));
  }

  setOpen(open: boolean): void {
    this.el.classList.toggle('hidden', !open);
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden');
  }
}
