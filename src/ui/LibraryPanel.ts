import { h, svgIcon } from './dom';
import { icons } from './icons';
import type { ModelLibrary } from '../models/library';
import type { ThumbnailRenderer } from '../models/thumbnails';
import type { ModelDef } from '../models/schema';
import { BUILTIN_CATEGORIES } from '../models/builtin';

export interface LibraryCallbacks {
  onPick(model: ModelDef): void;
  onImport(): void;
  onDelete(model: ModelDef): void;
  onEdit(model: ModelDef): void;
  onExport(model: ModelDef): void;
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
    this.search = h('input', { class: 'lib-search', type: 'search', placeholder: 'Search models…', oninput: () => this.render() });
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.body = h('div', { class: 'lib-body' });
    this.el = h('div', { class: 'library panel' },
      h('div', { class: 'lib-head' },
        h('div', { class: 'lib-title' }, h('span', {}, 'Library'), h('span', { class: 'insp-sub' }, 'click a model, then click in the scene')),
        h('div', { class: 'lib-tabs' }, this.tabs.builtin, this.tabs.mine),
        this.search),
      this.body,
      h('div', { class: 'lib-actions' },
        h('button', { class: 'btn grow', onclick: () => cb.onImport(), title: 'Import .glb / .gltf / .obj / .stl or a .physmodel.json' }, svgIcon(icons.upload), 'Import model')),
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
    const card = h('div', { class: `lib-card${m.id === this.activeId ? ' active' : ''}`, 'data-id': m.id, title: m.description || m.name, onclick: () => this.cb.onPick(m) },
      img, h('div', { class: 'name' }, m.name));
    if (mine) {
      const del = h('button', { class: 'del', title: 'Delete', onclick: (e: Event) => { e.stopPropagation(); this.cb.onDelete(m); } }, '×');
      card.append(del);
    }
    card.title = `${m.description || m.name}\nRight-click: open in the Model Builder${mine ? '' : ' (as a copy)'}`;
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
      for (const cat of BUILTIN_CATEGORIES) {
        const models = this.library.builtin.filter((m) => m.category === cat && match(m));
        if (!models.length) continue;
        this.body.append(h('div', { class: 'lib-cat' }, cat), h('div', { class: 'lib-grid' }, ...models.map((m) => this.card(m, false))));
      }
    } else {
      const models = this.library.user.filter(match);
      if (!models.length) {
        this.body.append(h('div', { class: 'lib-empty' },
          'No models yet.', h('br'), 'Make one in ', h('b', {}, 'Build'), ' mode, or import a ', h('b', {}, '.glb'), ' from Blender.'));
      } else {
        this.body.append(h('div', { class: 'lib-grid' }, ...models.map((m) => this.card(m, true))));
        this.body.append(h('div', { class: 'insp-sub', style: 'margin-top:10px' }, 'Right-click any model to edit it in the builder.'));
      }
    }
  }
}
