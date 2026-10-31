import { h, svgIcon } from './dom';
import { icons } from './icons';
import type { SettingsStore } from '../app/settings';

export interface BottomBarCallbacks {
  onTogglePause(): void;
  onStep(): void;
  onReset(): void;
  onClear(): void;
  onPhoto(): void;
}

function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(0) + 'k';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return n.toFixed(0);
}

export class BottomBar {
  readonly el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private scale: HTMLInputElement;
  private scaleVal: HTMLElement;
  private stats: HTMLElement;

  constructor(private settings: SettingsStore, cb: BottomBarCallbacks) {
    this.playBtn = h('button', { class: 'icon-btn', title: 'Pause / play (Space)', onclick: () => cb.onTogglePause() }, svgIcon(icons.pause));
    const step = h('button', { class: 'icon-btn', title: 'Step one frame (.)', onclick: () => cb.onStep() }, svgIcon(icons.step));
    const reset = h('button', { class: 'icon-btn', title: 'Reset scenario (R)', onclick: () => cb.onReset() }, svgIcon(icons.reset));
    const clear = h('button', { class: 'icon-btn', title: 'Clear everything (Shift+Del)', onclick: () => cb.onClear() }, svgIcon(icons.clear));
    const photo = h('button', { class: 'icon-btn', title: 'Save image (P)', onclick: () => cb.onPhoto() }, svgIcon(icons.camera));
    // Logarithmic slider: 0.05× … 2×
    this.scale = h('input', { type: 'range', min: -3, max: 1, step: 0.01, value: 0, title: 'Time scale' });
    this.scaleVal = h('span', { class: 'val' }, '1.00×');
    this.scale.addEventListener('input', () => {
      const v = Math.pow(2, Number(this.scale.value));
      settings.set('physics', 'timeScale', Math.max(0.05, Math.min(2, v)));
    });
    this.scale.addEventListener('keydown', (e) => e.stopPropagation());
    this.stats = h('div', { class: 'stats' });
    this.el = h('div', { class: 'bottombar panel' },
      this.playBtn, step, reset, clear, photo,
      h('div', { class: 'tool-sep' }),
      h('label', { class: 'time-scale' }, 'Speed', this.scale, this.scaleVal),
      h('div', { class: 'tool-sep' }),
      this.stats);
    settings.on((p) => {
      if (p === 'physics.paused') this.syncPaused();
      if (p === 'physics.timeScale') this.syncScale();
    });
    this.syncPaused();
    this.syncScale();
  }

  private syncPaused(): void {
    const paused = this.settings.data.physics.paused;
    this.playBtn.replaceChildren(svgIcon(paused ? icons.play : icons.pause));
    this.playBtn.classList.toggle('active', paused);
  }

  private syncScale(): void {
    const v = this.settings.data.physics.timeScale;
    this.scaleVal.textContent = `${v.toFixed(2)}×`;
    const s = Math.log2(v);
    if (Math.abs(Number(this.scale.value) - s) > 0.02) this.scale.value = String(s);
  }

  setStats(s: { fps: number; bodies: number; particles: number; kinetic: number }): void {
    this.stats.replaceChildren(
      h('span', {}, h('b', {}, String(Math.round(s.fps))), ' fps'),
      h('span', {}, h('b', {}, String(s.bodies)), ' bodies'),
      h('span', {}, h('b', {}, fmt(s.particles)), ' particles'),
      h('span', { title: 'Total kinetic energy' }, h('b', {}, fmt(s.kinetic)), ' J'),
    );
  }
}
