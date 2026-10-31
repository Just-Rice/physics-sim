import type { AppContext } from '../app/context';

export interface ToolPointer {
  x: number;
  y: number;
  button: number;
  shift: boolean;
  alt: boolean;
}

export abstract class Tool {
  abstract readonly id: string;
  abstract readonly label: string;
  abstract readonly icon: string;
  abstract readonly key: string;
  abstract readonly hint: string;

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
  /** Called every animation frame. */
  update(_dt: number): void {}
  activate(): void {}
  deactivate(): void {}
}
