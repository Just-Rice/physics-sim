import { h, svgIcon } from './dom';
import { icons } from './icons';
import type { ToolManager } from '../tools/ToolManager';
import { SCENARIOS } from '../scenes/scenarios';

export interface TopBarCallbacks {
  onScenario(id: string): void;
  onMode(mode: 'play' | 'build'): void;
  onRayTracing(on: boolean): void;
  onToggleSettings(): void;
  onToggleLibrary(): void;
  onHelp(): void;
}

export class TopBar {
  readonly el: HTMLElement;
  private toolButtons = new Map<string, HTMLButtonElement>();
  private rtEl: HTMLElement;
  private rtSub: HTMLElement;
  private modeBtns: Record<'play' | 'build', HTMLButtonElement>;
  readonly scenarioSelect: HTMLSelectElement;
  private settingsBtn: HTMLButtonElement;
  private libraryBtn: HTMLButtonElement;
  readonly toolbar: HTMLElement;

  constructor(tools: ToolManager, cb: TopBarCallbacks) {
    this.scenarioSelect = h('select', { class: 'select', title: 'Load a scenario', onchange: () => cb.onScenario(this.scenarioSelect.value) },
      ...SCENARIOS.map((s) => h('option', { value: s.id }, s.name)));

    this.modeBtns = {
      play: h('button', { class: 'active', onclick: () => cb.onMode('play'), title: 'Simulate (P)' }, 'Play'),
      build: h('button', { onclick: () => cb.onMode('build'), title: 'Model Builder (B)' }, 'Build'),
    };

    this.libraryBtn = h('button', { class: 'icon-btn active', title: 'Library (L)', onclick: () => cb.onToggleLibrary() }, svgIcon(icons.library));

    this.toolbar = h('div', { class: 'toolbar panel' });
    for (const t of tools.tools) {
      const b = h('button', { class: 'tool-btn', title: `${t.label} (${t.key})`, onclick: () => tools.setTool(t.id) },
        svgIcon(t.icon), h('span', { class: 'txt' }, t.label), h('span', { class: 'kbd' }, t.key));
      this.toolButtons.set(t.id, b);
      this.toolbar.append(b);
    }
    tools.onChange((t) => this.setActiveTool(t.id));
    this.setActiveTool(tools.active.id);

    this.rtSub = h('span', { class: 'sub' }, 'Off · raster preview');
    this.rtEl = h('div', { class: 'rt-toggle panel', role: 'switch', tabindex: 0, title: 'Hyper-realistic path tracing (T)' },
      h('div', { class: 'switch' }),
      h('div', {}, h('div', { class: 'label' }, 'Ray tracing'), this.rtSub));
    const toggle = () => {
      if (this.rtEl.classList.contains('disabled')) return;
      cb.onRayTracing(!this.rtEl.classList.contains('on'));
    };
    this.rtEl.addEventListener('click', toggle);
    this.rtEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

    this.settingsBtn = h('button', { class: 'icon-btn', title: 'Settings (G)', onclick: () => cb.onToggleSettings() }, svgIcon(icons.settings));
    const helpBtn = h('button', { class: 'icon-btn', title: 'Help (H)', onclick: () => cb.onHelp() }, svgIcon(icons.help));

    this.el = h('div', { class: 'topbar' },
      h('div', { class: 'brand panel' }, h('div', { class: 'brand-mark' }), h('span', { class: 'brand-name' }, 'Physics Sim'), this.scenarioSelect),
      h('div', { class: 'mode-switch panel' }, this.modeBtns.play, this.modeBtns.build),
      h('div', { class: 'panel', style: 'display:flex' }, this.libraryBtn),
      this.toolbar,
      h('div', { class: 'right-group' }, this.rtEl, h('div', { class: 'panel', style: 'display:flex' }, this.settingsBtn, helpBtn)),
    );
  }

  setActiveTool(id: string): void {
    for (const [k, b] of this.toolButtons) b.classList.toggle('active', k === id);
  }

  setMode(mode: 'play' | 'build'): void {
    this.modeBtns.play.classList.toggle('active', mode === 'play');
    this.modeBtns.build.classList.toggle('active', mode === 'build');
    this.toolbar.style.visibility = mode === 'play' ? 'visible' : 'hidden';
    this.scenarioSelect.disabled = mode === 'build';
  }

  setRayTracing(on: boolean, sub?: string): void {
    this.rtEl.classList.toggle('on', on);
    this.rtEl.setAttribute('aria-checked', String(on));
    this.rtSub.textContent = sub ?? (on ? 'Path tracing' : 'Off · raster preview');
  }

  setRayTracingUnavailable(reason: string): void {
    this.rtEl.classList.add('disabled');
    this.rtEl.title = reason;
    this.rtSub.textContent = 'Unavailable';
  }

  setSettingsOpen(open: boolean): void {
    this.settingsBtn.classList.toggle('active', open);
  }

  setLibraryOpen(open: boolean): void {
    this.libraryBtn.classList.toggle('active', open);
  }
}
