import type { SavedScene } from '../scenes/sceneIO';

export interface HistoryEntry {
  label: string;
  scene: SavedScene;
}

/**
 * Undo/redo for Play mode, built on whole-scene snapshots (the same format as
 * "Save scene"). Snapshots are taken *before* a change; quick repeats of the
 * same action (rapid cannon fire, several explosions) share one step.
 */
export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private lastLabel = '';
  private lastTime = 0;
  private listeners = new Set<() => void>();

  constructor(private limit = 30) {}

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Label of the step that undo would revert. */
  get undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  /**
   * Record the state before an action. `snapshot` is only called when a new
   * step is actually needed, so coalesced calls stay cheap.
   */
  record(label: string, snapshot: () => SavedScene, coalesceMs = 0, now = Date.now()): boolean {
    if (coalesceMs > 0 && label === this.lastLabel && now - this.lastTime < coalesceMs) {
      this.lastTime = now;
      return false;
    }
    this.lastLabel = label;
    this.lastTime = now;
    this.undoStack.push({ label, scene: snapshot() });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
    return true;
  }

  /** Step back. `current` is the state now, kept so redo can return to it. */
  undo(current: () => SavedScene): HistoryEntry | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, scene: current() });
    this.lastLabel = '';
    this.emit();
    return e;
  }

  redo(current: () => SavedScene): HistoryEntry | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, scene: current() });
    this.lastLabel = '';
    this.emit();
    return e;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastLabel = '';
    this.emit();
  }
}
