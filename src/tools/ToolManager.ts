import type { AppContext } from '../app/context';
import type { HoverInfo, Tool, ToolPointer } from './Tool';
import { HandTool } from './HandTool';
import { AttractTool, CannonTool, EraseTool, ExplodeTool, SpawnTool } from './actionTools';
import { Highlighter } from '../render/highlight';

/**
 * Routes pointer events from the canvas to the active tool, arbitrates with
 * the orbit controls, and drives hover feedback (cursor, hint, highlight).
 */
export class ToolManager {
  readonly tools: Tool[];
  active: Tool;
  readonly spawn: SpawnTool;
  private consumed = false;
  private primaryPointer: number | null = null;
  private touches = new Set<number>();
  private listeners = new Set<(t: Tool) => void>();
  private hoverListeners = new Set<(info: HoverInfo | null) => void>();
  private hoverPointer: ToolPointer | null = null;
  private hoverDirty = false;
  private lastHover = 0;
  private highlighter = new Highlighter();
  private _enabled = true;

  constructor(private ctx: AppContext, private dom: HTMLElement) {
    this.spawn = new SpawnTool(ctx);
    this.tools = [new HandTool(ctx), this.spawn, new CannonTool(ctx), new ExplodeTool(ctx), new AttractTool(ctx), new EraseTool(ctx)];
    this.active = this.tools[0];

    // Capture phase so a consumed press disables OrbitControls before it sees the event.
    dom.addEventListener('pointerdown', (e) => this.down(e), { capture: true });
    dom.addEventListener('pointermove', (e) => this.hoverMove(e));
    dom.addEventListener('pointerleave', () => this.hoverLeave());
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
    window.addEventListener('blur', () => this.cancel());
    dom.addEventListener('wheel', (e) => this.wheel(e), { passive: false, capture: true });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(on: boolean) {
    if (on === this._enabled) return;
    this._enabled = on;
    if (!on) {
      this.cancel();
      this.hoverLeave();
    }
  }

  onChange(fn: (t: Tool) => void): void {
    this.listeners.add(fn);
  }

  /** Hover feedback (null = pointer left the scene or tools are off). */
  onHover(fn: (info: HoverInfo | null) => void): void {
    this.hoverListeners.add(fn);
  }

  setTool(id: string): void {
    const t = this.tools.find((x) => x.id === id);
    if (!t || t === this.active) return;
    this.cancel();
    this.active.deactivate();
    this.active = t;
    t.activate();
    this.hoverDirty = true;
    this.listeners.forEach((l) => l(t));
  }

  private ptr(e: PointerEvent): ToolPointer {
    return { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey, alt: e.altKey };
  }

  /** Abort any press in progress (tool switch, window blur, second finger). */
  cancel(): void {
    if (this.consumed) {
      this.active.onUp({ x: 0, y: 0, button: 0, shift: false, alt: false });
      this.consumed = false;
    }
    this.primaryPointer = null;
    this.ctx.view.controls.enabled = true;
  }

  private down(e: PointerEvent): void {
    if (e.pointerType === 'touch') this.touches.add(e.pointerId);
    if (!this._enabled) return;
    // A second finger means a pinch / two-finger orbit: hand it to the camera.
    if (this.primaryPointer !== null || this.touches.size > 1) {
      if (e.pointerType === 'touch') this.cancel();
      return;
    }
    // Alt / right / middle drag always moves the camera.
    if (e.altKey || e.button !== 0) return;
    this.consumed = this.active.onDown(this.ptr(e));
    if (this.consumed) {
      this.primaryPointer = e.pointerId;
      this.ctx.view.controls.enabled = false;
      this.dom.setPointerCapture?.(e.pointerId);
      this.dom.style.cursor = this.active.activeCursor;
      this.highlighter.clear();
    }
  }

  private move(e: PointerEvent): void {
    if (!this._enabled || !this.consumed || e.pointerId !== this.primaryPointer) return;
    this.active.onMove(this.ptr(e));
  }

  private up(e: PointerEvent): void {
    this.touches.delete(e.pointerId);
    if (!this._enabled) return;
    if (this.consumed && e.pointerId === this.primaryPointer) {
      this.active.onUp(this.ptr(e));
      this.consumed = false;
      this.primaryPointer = null;
      this.ctx.view.controls.enabled = true;
      this.hoverDirty = true;
    }
  }

  private wheel(e: WheelEvent): void {
    if (!this._enabled) return;
    if (this.active.onWheel(e.deltaY)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  private hoverMove(e: PointerEvent): void {
    if (!this._enabled || e.pointerType === 'touch') return;
    this.hoverPointer = this.ptr(e);
    this.hoverDirty = true;
    // Tools like Place want every move (ghost outline), even without a press.
    if (!this.consumed) this.active.onMove(this.hoverPointer);
  }

  private hoverLeave(): void {
    this.hoverPointer = null;
    this.highlighter.clear();
    this.dom.style.cursor = '';
    this.hoverListeners.forEach((l) => l(null));
    if (this.active === this.spawn) this.spawn.hidePreview();
  }

  private updateHover(): void {
    const now = performance.now();
    // Raycast at most ~30×/s, plus a slow refresh because things move under a still cursor.
    if (!this.hoverPointer || this.consumed) return;
    if (!this.hoverDirty && now - this.lastHover < 200) return;
    if (now - this.lastHover < 33) return;
    this.lastHover = now;
    this.hoverDirty = false;
    const hit = this.ctx.pick(this.hoverPointer.x, this.hoverPointer.y);
    const info = this.active.hover(hit);
    this.dom.style.cursor = info.cursor;
    this.highlighter.set(info.highlight ?? null, info.highlightColor);
    this.hoverListeners.forEach((l) => l(info));
  }

  /** Drop any highlight (entities were removed or the scene was rebuilt). */
  clearHighlight(): void {
    this.highlighter.clear();
    this.hoverDirty = true;
  }

  update(dt: number): void {
    if (!this._enabled) return;
    if (this.highlighter.current && !this.highlighter.current.body.isValid()) this.highlighter.clear();
    this.updateHover();
    this.active.update(dt);
  }
}
