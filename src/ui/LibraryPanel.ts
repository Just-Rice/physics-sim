import { h, svgIcon } from './dom';
import { icons } from './icons';
import type { ModelLibrary } from '../models/library';
import type { ThumbnailRenderer } from '../models/thumbnails';
import type { ModelDef } from '../models/schema';
import { BUILTIN_CATEGORIES } from '../models/builtin';

/** MIME type used when dragging a library card into the scene. */
export const MODEL_DRAG_TYPE = 'application/x-physics-sim-model';

export interface LibraryCallbacks {
  onPick(model: ModelDef): void;
  /** Double-click: drop the model straight into view. */
  onQuickAdd(model: ModelDef): void;
  onImport(): void;
  onDelete(model: ModelDef): void;
  onEdit(model: ModelDef): void;
  onExport(model: ModelDef): void;
  onClose(): void;
}

export class LibraryPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tab: 'builtin' | 'mine' = 'builtin';
  private tabs: Record<'builtin' | 'mine', HTMLButtonElement>;
  private search: HTMLInputElement;
  private activeId: string | null = null;
  private observer: IntersectionObserver;

  constructor(private library: ModelLibrary, private thumbs: ThumbnailRenderer, private cb: LibraryCallbacks) {
    this.tabs = {
      builtin: h('button', { class: 'active', onclick: () => this.setTab('builtin') }, 'Built-in'),
      mine: h('button', { onclick: () => this.setTab('mine') }, 'My models'),
    };
    this.search = h('input', { class: 'lib-search', type: 'search', placeholder: 'Search models…', 'aria-label': 'Search models', oninput: () => this.render() });
    this.search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        this.search.value = '';
        this.render();
        this.search.blur();
      }
    });
    this.body = h('div', { class: 'lib-body' });
    this.el = h('div', { class: 'library panel', 'aria-label': 'Model library' },
      h('div', { class: 'lib-head' },
        h('div', { class: 'lib-title' },
          h('span', {}, 'Library'),
          h('button', { class: 'icon-btn sheet-close', title: 'Close (L)', 'aria-label': 'Close library', onclick: () => cb.onClose() }, svgIcon(icons.close))),
        h('div', { class: 'lib-help' }, 'Drag a model into the scene — or click it, then click where it should go.'),
        h('div', { class: 'lib-tabs', role: 'tablist' }, this.tabs.builtin, this.tabs.mine),
        this.search),
      this.body,
      h('div', { class: 'lib-actions' },
        h('button', { class: 'btn grow', onclick: () => cb.onImport(), title: 'Import .glb / .gltf / .obj / .stl or a .physmodel.json' }, svgIcon(icons.upload), 'Import a model…')),
    );
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target as HTMLImageElement;
        this.observer.unobserve(img);
        const model = this.library.get(img.dataset.id!);
        if (model) this.thumbs.get(model).then((url) => { if (url) img.src = url; });
      }
    }, { root: this.body });
    library.onChange(() => this.render());
    this.render();
  }

  setTab(t: 'builtin' | 'mine'): void {
    this.tab = t;
    this.tabs.builtin.classList.toggle('active', t === 'builtin');
    this.tabs.mine.classList.toggle('active', t === 'mine');
    this.render();
  }

  setActive(id: string | null): void {
    this.activeId = id;
    this.body.querySelectorAll<HTMLElement>('.lib-card').forEach((c) => c.classList.toggle('active', c.dataset.id === id));
  }

  setOpen(open: boolean): void {
    this.el.classList.toggle('collapsed', !open);
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('collapsed');
  }

  refreshThumb(id: string): void {
    this.thumbs.invalidate(id);
    this.render();
  }

  private card(m: ModelDef, mine: boolean): HTMLElement {
    const img = h('img', { alt: '', 'data-id': m.id, draggable: false });
    this.observer.observe(img);
    const card = h('div', {
      class: `lib-card${m.id === this.activeId ? ' active' : ''}`,
      'data-id': m.id,
      draggable: 'true',
      tabindex: 0,
      role: 'button',
      'aria-label': m.name,
      onclick: () => this.cb.onPick(m),
      ondblclick: () => this.cb.onQuickAdd(m),
    }, img, h('div', { class: 'name' }, m.name));
    card.title = `${m.description ? m.description + '\n' : ''}Drag into the scene · double-click to drop it in view · right-click to edit${mine ? '' : ' a copy'} in Build`;
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.cb.onQuickAdd(m);
      else if (e.key === ' ') this.cb.onPick(m);
      else return; // every other key keeps working as a shortcut
      e.preventDefault();
      e.stopPropagation();
    });
    card.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData(MODEL_DRAG_TYPE, m.id);
      e.dataTransfer.setData('text/plain', m.name);
      e.dataTransfer.effectAllowed = 'copy';
      if (img.complete && img.naturalWidth) e.dataTransfer.setDragImage(img, 32, 32);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    if (mine) {
      const del = h('button', { class: 'del', title: 'Delete from library', 'aria-label': `Delete ${m.name}`, onclick: (e: Event) => { e.stopPropagation(); this.cb.onDelete(m); } }, '×');
      card.append(del);
    }
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.cb.onEdit(m);
    });
    return card;
  }

  render(): void {
    const q = this.search.value.trim().toLowerCase();
    const match = (m: ModelDef) => !q || m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q) || m.description.toLowerCase().includes(q);
    this.body.replaceChildren();
    if (this.tab === 'builtin') {
      let any = false;
      for (const cat of BUILTIN_CATEGORIES) {
        const models = this.library.builtin.filter((m) => m.category === cat && match(m));
        if (!models.length) continue;
        any = true;
        this.body.append(h('div', { class: 'lib-cat' }, cat), h('div', { class: 'lib-grid' }, ...models.map((m) => this.card(m, false))));
      }
      if (!any) this.body.append(h('div', { class: 'lib-empty' }, `Nothing matches “${q}”.`));
    } else {
      const models = this.library.user.filter(match);
      if (!models.length) {
        this.body.append(h('div', { class: 'lib-empty' },
          q ? `Nothing matches “${q}”.` : 'No models of your own yet.',
          h('br'), h('br'),
          h('button', { class: 'btn small', onclick: () => document.dispatchEvent(new CustomEvent('physics-sim:build')) }, 'Open the Model Builder'),
          h('br'), h('br'),
          'or import a .glb from Blender.'));
      } else {
        this.body.append(h('div', { class: 'lib-grid' }, ...models.map((m) => this.card(m, true))));
        this.body.append(h('div', { class: 'insp-sub', style: 'margin-top:10px' }, 'Right-click a model to change it in the Builder.'));
      }
    }
  }
}
