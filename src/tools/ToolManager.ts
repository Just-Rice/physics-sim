import type { AppContext } from '../app/context';
import type { Tool, ToolPointer } from './Tool';
import { HandTool } from './HandTool';
import { AttractTool, CannonTool, EraseTool, ExplodeTool, SpawnTool } from './actionTools';

/** Routes pointer events from the canvas to the active tool and arbitrates with orbit controls. */
export class ToolManager {
  readonly tools: Tool[];
  active: Tool;
  readonly spawn: SpawnTool;
  private consumed = false;
  private listeners = new Set<(t: Tool) => void>();
  enabled = true;

  constructor(private ctx: AppContext, private dom: HTMLElement) {
    this.spawn = new SpawnTool(ctx);
    this.tools = [new HandTool(ctx), this.spawn, new CannonTool(ctx), new ExplodeTool(ctx), new AttractTool(ctx), new EraseTool(ctx)];
    this.active = this.tools[0];

    // Capture phase so a consumed press disables OrbitControls before it sees the event.
    dom.addEventListener('pointerdown', (e) => this.down(e), { capture: true });
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    dom.addEventListener('wheel', (e) => this.wheel(e), { passive: false, capture: true });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  onChange(fn: (t: Tool) => void): void {
    this.listeners.add(fn);
  }

  setTool(id: string): void {
    const t = this.tools.find((x) => x.id === id);
    if (!t || t === this.active) return;
    this.active.deactivate();
    this.active = t;
    t.activate();
    this.listeners.forEach((l) => l(t));
  }

  private ptr(e: PointerEvent): ToolPointer {
    return { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey, alt: e.altKey };
  }

  private down(e: PointerEvent): void {
    if (!this.enabled) return;
    // Alt / right / middle drag always orbits the camera.
    if (e.altKey || e.button !== 0) return;
    this.consumed = this.active.onDown(this.ptr(e));
    if (this.consumed) {
      this.ctx.view.controls.enabled = false;
      this.dom.setPointerCapture?.(e.pointerId);
    }
  }

  private move(e: PointerEvent): void {
    if (!this.enabled) return;
    if (e.target !== this.dom && !this.consumed) return;
    this.active.onMove(this.ptr(e));
  }

  private up(e: PointerEvent): void {
    if (!this.enabled) return;
    if (this.consumed) {
      this.active.onUp(this.ptr(e));
      this.consumed = false;
      this.ctx.view.controls.enabled = true;
    }
  }

  private wheel(e: WheelEvent): void {
    if (!this.enabled) return;
    if (this.active.onWheel(e.deltaY)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  update(dt: number): void {
    if (!this.enabled) return;
    this.active.update(dt);
  }
}
