import { h, svgIcon } from './dom';
import { icons } from './icons';
import type { SettingsStore } from '../app/settings';

export interface BottomBarCallbacks {
  onTogglePause(): void;
  onStep(): void;
  onUndo(): void;
  onRedo(): void;
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

const MIN_SCALE = 0.05;
const MAX_SCALE = 2;

export class BottomBar {
  readonly el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private scale: HTMLInputElement;
  private scaleVal: HTMLElement;
  private stat: Record<'fps' | 'bodies' | 'particles' | 'energy', HTMLElement>;

  constructor(private settings: SettingsStore, cb: BottomBarCallbacks) {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const mod = isMac ? '⌘' : 'Ctrl+';
    this.playBtn = h('button', { class: 'icon-btn play-btn', title: 'Pause / play (Space)', 'aria-label': 'Pause', onclick: () => cb.onTogglePause() }, svgIcon(icons.pause));
    const step = h('button', { class: 'icon-btn', title: 'Step one frame (.)', 'aria-label': 'Step one frame', onclick: () => cb.onStep() }, svgIcon(icons.step));
    this.undoBtn = h('button', { class: 'icon-btn', title: `Undo (${mod}Z)`, 'aria-label': 'Undo', onclick: () => cb.onUndo() }, svgIcon(icons.undo));
    this.redoBtn = h('button', { class: 'icon-btn', title: `Redo (${mod}Shift+Z)`, 'aria-label': 'Redo', onclick: () => cb.onRedo() }, svgIcon(icons.redo));
    const reset = h('button', { class: 'icon-btn', title: 'Reset to how the scene started (R)', 'aria-label': 'Reset scene', onclick: () => cb.onReset() }, svgIcon(icons.reset));
    const clear = h('button', { class: 'icon-btn', title: 'Remove everything (Shift+Del)', 'aria-label': 'Clear scene', onclick: () => cb.onClear() }, svgIcon(icons.clear));
    const photo = h('button', { class: 'icon-btn', title: 'Save a picture (P)', 'aria-label': 'Save a picture', onclick: () => cb.onPhoto() }, svgIcon(icons.camera));
    // Logarithmic slider over 0.05× … 2×
    this.scale = h('input', { type: 'range', min: Math.log2(MIN_SCALE), max: Math.log2(MAX_SCALE), step: 0.01, value: 0, 'aria-label': 'Simulation speed' });
    this.scaleVal = h('span', { class: 'val' }, '1.00×');
    this.scale.addEventListener('input', () => {
      let v = Math.pow(2, Number(this.scale.value));
      // Snap to 1× near the middle so "normal speed" is easy to hit.
      if (Math.abs(v - 1) < 0.06) v = 1;
      settings.set('physics', 'timeScale', Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(v * 100) / 100)));
    });
    this.scale.addEventListener('dblclick', () => settings.set('physics', 'timeScale', 1));
    this.scale.addEventListener('keydown', (e) => e.stopPropagation());
    const stat = (title: string, unit: string) => {
      const b = h('b', {}, '0');
      return { el: h('span', { title }, b, unit), b };
    };
    const fps = stat('Frames per second', ' fps');
    const bodies = stat('Rigid bodies in the scene', ' bodies');
    const particles = stat('Cloth, jelly and water particles', ' particles');
    const energy = stat('Total kinetic energy', ' J');
    this.stat = { fps: fps.b, bodies: bodies.b, particles: particles.b, energy: energy.b };
    this.el = h('div', { class: 'bottombar panel', role: 'toolbar', 'aria-label': 'Simulation controls' },
      this.playBtn, step,
      h('div', { class: 'tool-sep' }),
      this.undoBtn, this.redoBtn, reset, clear, photo,
      h('div', { class: 'tool-sep' }),
      h('label', { class: 'time-scale', title: 'Slow motion — double-click for normal speed' }, h('span', { class: 'lbl' }, 'Speed'), this.scale, this.scaleVal),
      h('div', { class: 'tool-sep stats-sep' }),
      h('div', { class: 'stats' }, fps.el, bodies.el, particles.el, energy.el));
    settings.on((p) => {
      if (p === 'physics.paused') this.syncPaused();
      if (p === 'physics.timeScale') this.syncScale();
    });
    this.syncPaused();
    this.syncScale();
    this.setHistory(false, false);
  }

  private syncPaused(): void {
    const paused = this.settings.data.physics.paused;
    this.playBtn.replaceChildren(svgIcon(paused ? icons.play : icons.pause));
    this.playBtn.classList.toggle('active', paused);
    this.playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  }

  private syncScale(): void {
    const v = this.settings.data.physics.timeScale;
    this.scaleVal.textContent = `${v.toFixed(2)}×`;
    const s = Math.log2(Math.max(MIN_SCALE, v));
    if (Math.abs(Number(this.scale.value) - s) > 0.02) this.scale.value = String(s);
  }

  setHistory(canUndo: boolean, canRedo: boolean, undoLabel?: string | null, redoLabel?: string | null): void {
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
    this.undoBtn.title = canUndo && undoLabel ? `Undo ${undoLabel}` : 'Nothing to undo';
    this.redoBtn.title = canRedo && redoLabel ? `Redo ${redoLabel}` : 'Nothing to redo';
  }

  /** Cheap: only text nodes change. */
  setStats(s: { fps: number; bodies: number; particles: number; kinetic: number }): void {
    this.stat.fps.textContent = String(Math.round(s.fps));
    this.stat.bodies.textContent = String(s.bodies);
    this.stat.particles.textContent = fmt(s.particles);
    this.stat.energy.textContent = fmt(s.kinetic);
  }
}
