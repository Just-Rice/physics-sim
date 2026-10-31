import { createStore, del, entries, get, set, type UseStore } from 'idb-keyval';
import { BUILTIN_MODELS } from './builtin';
import { safeParseModel, type ModelDef } from './schema';

export interface StoredAsset {
  id: string;
  name: string;
  bytes: ArrayBuffer;
  /** File extension the bytes came from (glb, gltf, obj, stl). */
  ext: string;
}

type AssetLoader = (asset: StoredAsset) => Promise<void>;

/**
 * Built-in models plus the user's own models (IndexedDB). Imported mesh
 * assets are stored next to the models and parsed on load.
 */
export class ModelLibrary {
  readonly builtin = BUILTIN_MODELS;
  user: ModelDef[] = [];
  private byId = new Map<string, ModelDef>();
  private listeners = new Set<() => void>();
  private modelStore: UseStore | null = null;
  private assetStore: UseStore | null = null;
  assetLoader: AssetLoader | null = null;

  constructor() {
    for (const m of this.builtin) this.byId.set(m.id, m);
    try {
      if (typeof indexedDB !== 'undefined') {
        this.modelStore = createStore('physics-sim-models', 'models');
        this.assetStore = createStore('physics-sim-assets', 'assets');
      }
    } catch {
      this.modelStore = this.assetStore = null;
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  get(id: string): ModelDef | undefined {
    return this.byId.get(id);
  }

  all(): ModelDef[] {
    return [...this.builtin, ...this.user];
  }

  async load(): Promise<void> {
    if (!this.modelStore || !this.assetStore) return;
    try {
      if (this.assetLoader) {
        const assets = await entries<string, StoredAsset>(this.assetStore);
        for (const [, a] of assets) {
          try {
            await this.assetLoader(a);
          } catch (err) {
            console.warn('Could not load stored asset', a.name, err);
          }
        }
      }
      const rows = await entries<string, unknown>(this.modelStore);
      this.user = [];
      for (const [, raw] of rows) {
        const r = safeParseModel(raw);
        if (r.ok) {
          this.user.push(r.model);
          this.byId.set(r.model.id, r.model);
        }
      }
      this.user.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.warn('Library storage unavailable', err);
    }
    this.emit();
  }

  /** Add or replace a user model (and optionally its mesh assets). */
  async saveUserModel(model: ModelDef, assets: StoredAsset[] = []): Promise<void> {
    if (this.builtin.some((b) => b.id === model.id)) model = { ...model, id: `${model.id}-${Date.now().toString(36)}` };
    const i = this.user.findIndex((m) => m.id === model.id);
    if (i >= 0) this.user[i] = model;
    else this.user.push(model);
    this.byId.set(model.id, model);
    try {
      if (this.modelStore) await set(model.id, model, this.modelStore);
      if (this.assetStore) for (const a of assets) await set(a.id, a, this.assetStore);
    } catch (err) {
      console.warn('Could not persist model', err);
    }
    this.emit();
  }

  async getStoredAsset(id: string): Promise<StoredAsset | undefined> {
    if (!this.assetStore) return undefined;
    return get<StoredAsset>(id, this.assetStore);
  }

  async deleteUserModel(id: string): Promise<void> {
    this.user = this.user.filter((m) => m.id !== id);
    this.byId.delete(id);
    try {
      if (this.modelStore) await del(id, this.modelStore);
    } catch {
      /* ignore */
    }
    this.emit();
  }

  uniqueId(base: string): string {
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';
    let id = `user-${slug}`;
    let n = 2;
    while (this.byId.has(id)) id = `user-${slug}-${n++}`;
    return id;
  }
}
