import type { AppContext, PickResult } from '../app/context';
import type { PartInstance } from '../sim/types';

export interface ToolPointer {
  x: number;
  y: number;
  button: number;
  shift: boolean;
  alt: boolean;
}

/** What the UI should show while the pointer hovers over something. */
export interface HoverInfo {
  cursor: string;
  /** Contextual hint; falls back to the tool's own hint. */
  hint?: string;
  /** Part to highlight, and how. */
  highlight?: PartInstance | null;
  highlightColor?: number;
}

export abstract class Tool {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly icon: string;
  abstract readonly key: string;
  abstract readonly hint: string;
  /** The same hint for fingers: no hovering, right-clicks, keys or scroll wheel. */
  get touchHint(): string {
    return this.hint;
  }
  /** One line shown in the toolbar tooltip. */
  abstract readonly description: string;

  constructor(protected ctx: AppContext) {}

  /** Return true to consume the event (disables camera orbit until pointer up). */
  onDown(_p: ToolPointer): boolean {
    return false;
  }
  onMove(_p: ToolPointer): void {}
  onUp(_p: ToolPointer): void {}
  /** Return true to consume the wheel event. */
  onWheel(_deltaY: number): boolean {
    return false;
  }
  /** Feedback for the thing under the cursor (not called while dragging). */
  hover(_hit: PickResult | null): HoverInfo {
    return { cursor: 'crosshair' };
  }
  /** Cursor while a press is being handled (dragging). */
  get activeCursor(): string {
    return 'crosshair';
  }
  /** Called every animation frame. */
  update(_dt: number): void {}
  activate(): void {}
  deactivate(): void {}
}
