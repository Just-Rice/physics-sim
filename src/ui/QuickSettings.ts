import { h } from './dom';
import { GRAVITY_PRESETS, RT_PRESETS, currentRtQuality, type EnvironmentPreset, type RtQuality, type SettingsStore } from '../app/settings';

const DIRECTIONS: [string, number][] = [['→ East', 0], ['↘ South-east', 45], ['↓ South', 90], ['↙ South-west', 135], ['← West', 180], ['↖ North-west', 225], ['↑ North', 270], ['↗ North-east', 315]];

const PROJECTILES: [string, string][] = [
  ['steel-ball', 'Steel ball'], ['rubber-ball', 'Rubber ball'], ['bowling-ball', 'Bowling ball'], ['glass-sphere', 'Glass sphere'],
  ['crate', 'Crate'], ['jelly-sphere', 'Jelly ball'], ['water-block', 'Water'], ['beach-ball', 'Beach ball'],
];

/**
 * The settings most people want, as big buttons. Everything else lives in
 * the "Advanced" panel below it.
 */
export class QuickSettings {
  readonly el: HTMLElement;
  private chips = new Map<string, HTMLButtonElement[]>();
  private windStrength: HTMLInputElement;
  private windVal: HTMLElement;
  private windDir: HTMLSelectElement;
  private projectile: HTMLSelectElement;

  constructor(private store: SettingsStore) {
    const group = (key: string, options: [string, string][], on: (v: string) => void) => {
      const btns = options.map(([v, label]) => {
        const b = h('button', { class: 'chip', 'data-v': v, onclick: () => { on(v); this.sync(); } }, label);
        return b;
      });
      this.chips.set(key, btns);
      return h('div', { class: 'chips' }, ...btns);
    };
    const section = (title: string, ...children: HTMLElement[]) => h('div', { class: 'qs-section' }, h('div', { class: 'qs-title' }, title), ...children);

    const gravity = group('gravity', [...Object.keys(GRAVITY_PRESETS).map((k) => [k, k] as [string, string]), ['orbits', 'Orbits']], (v) => {
      const p = store.data.physics;
      if (v === 'orbits') {
        store.set('physics', 'gravityMode', 'nbody');
        if (p.G <= 0) store.set('physics', 'G', 1);
        return;
      }
      store.set('physics', 'gravityMode', 'uniform');
      store.set('physics', 'gravityPreset', v);
      store.set('physics', 'gravity', GRAVITY_PRESETS[v]);
    });

    this.windStrength = h('input', { type: 'range', min: 0, max: 20, step: 0.5, value: 0, 'aria-label': 'Wind strength' });
    this.windVal = h('span', { class: 'num' }, '0');
    this.windDir = h('select', { class: 'select', 'aria-label': 'Wind direction' }, ...DIRECTIONS.map(([l, a]) => h('option', { value: a }, l)));
    const setWind = () => {
      const s = Number(this.windStrength.value);
      const a = (Number(this.windDir.value) * Math.PI) / 180;
      store.set('physics', 'windX', Math.round(Math.cos(a) * s * 100) / 100);
      store.set('physics', 'windZ', Math.round(Math.sin(a) * s * 100) / 100);
      this.windVal.textContent = `${s} m/s`;
    };
    this.windStrength.addEventListener('input', setWind);
    this.windDir.addEventListener('change', setWind);
    for (const el of [this.windStrength, this.windDir]) el.addEventListener('keydown', (e) => e.stopPropagation());

    const speed = group('speed', [['0.1', '0.1×'], ['0.25', '¼×'], ['0.5', '½×'], ['1', '1×'], ['2', '2×']], (v) => store.set('physics', 'timeScale', Number(v)));
    const look = group('look', [['day', 'Day'], ['golden', 'Golden hour'], ['studio', 'Studio'], ['night', 'Night']], (v) => store.set('render', 'environment', v as EnvironmentPreset));
    const rt = group('rt', (Object.keys(RT_PRESETS) as RtQuality[]).map((k) => [k, RT_PRESETS[k].label] as [string, string]), (v) => store.applyRtQuality(v as RtQuality));
    const show = group('show', [['trails', 'Motion trails'], ['shadows', 'Shadows'], ['grid', 'Grid floor']], (v) => {
      const r = store.data.render;
      if (v === 'trails') store.set('render', 'trails', !r.trails);
      if (v === 'shadows') store.set('render', 'shadows', !r.shadows);
      if (v === 'grid') store.set('render', 'showGrid', !r.showGrid);
    });

    this.projectile = h('select', { class: 'select', 'aria-label': 'Cannon projectile' }, ...PROJECTILES.map(([v, l]) => h('option', { value: v }, l)));
    this.projectile.addEventListener('change', () => store.set('tools', 'cannonModel', this.projectile.value));
    this.projectile.addEventListener('keydown', (e) => e.stopPropagation());

    this.el = h('div', { class: 'quick-settings panel' },
      h('div', { class: 'qs-head' }, 'Quick settings'),
      section('Gravity', gravity),
      section('Wind', h('div', { class: 'qs-row' }, this.windStrength, this.windVal), this.windDir),
      section('Speed', speed),
      section('Look', look),
      section('Ray-tracing quality', rt),
      section('Show', show),
      section('Cannon fires', this.projectile),
    );
    store.on(() => this.sync());
    this.sync();
  }

  private setActive(key: string, value: string | null, multi?: Set<string>): void {
    for (const b of this.chips.get(key) ?? []) {
      const on = multi ? multi.has(b.dataset.v!) : b.dataset.v === value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }

  sync(): void {
    const d = this.store.data;
    const p = d.physics;
    let g: string | null = null;
    if (p.gravityMode === 'nbody') g = 'orbits';
    else if (p.gravityMode === 'uniform') g = Object.entries(GRAVITY_PRESETS).find(([, v]) => Math.abs(v - p.gravity) < 1e-3)?.[0] ?? null;
    this.setActive('gravity', g);
    const ws = Math.hypot(p.windX, p.windZ);
    if (document.activeElement !== this.windStrength) this.windStrength.value = String(Math.round(ws * 2) / 2);
    this.windVal.textContent = `${Math.round(ws * 10) / 10} m/s`;
    if (ws > 0.01 && document.activeElement !== this.windDir) {
      const ang = ((Math.atan2(p.windZ, p.windX) * 180) / Math.PI + 360) % 360;
      this.windDir.value = String((Math.round(ang / 45) * 45) % 360);
    }
    const speed = ['0.1', '0.25', '0.5', '1', '2'].find((v) => Math.abs(Number(v) - p.timeScale) < 1e-3) ?? null;
    this.setActive('speed', speed);
    this.setActive('look', d.render.environment);
    this.setActive('rt', currentRtQuality(d));
    const shown = new Set<string>();
    if (d.render.trails) shown.add('trails');
    if (d.render.shadows) shown.add('shadows');
    if (d.render.showGrid) shown.add('grid');
    this.setActive('show', null, shown);
    if (this.projectile.value !== d.tools.cannonModel) this.projectile.value = d.tools.cannonModel;
  }
}
