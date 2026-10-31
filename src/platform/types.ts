export interface PickedFile {
  name: string;
  bytes: ArrayBuffer;
  /** Absolute path (desktop only). */
  path?: string;
}

export type MenuCommand =
  | 'open' | 'save-scene' | 'load-scene' | 'export-model' | 'render-photo'
  | 'toggle-raytracing' | 'toggle-pause' | 'step' | 'reset' | 'help' | 'watch-folder' | 'build-mode' | 'play-mode';

/** Surface the page uses for anything that differs between the browser and the Mac app. */
export interface Platform {
  kind: 'web' | 'desktop';
  openFiles(opts: { accept: string[]; multiple?: boolean }): Promise<PickedFile[]>;
  saveFile(name: string, data: Blob): Promise<boolean>;
  /** Desktop: choose (or reuse) a folder and watch it for .glb/.gltf changes. */
  watchFolder?(choose: boolean): Promise<string | null>;
  onWatchedFile?(cb: (file: PickedFile) => void): void;
  onMenu?(cb: (cmd: MenuCommand) => void): void;
  /** Hardware threads available to the particle solver. */
  hardwareThreads: number;
}

/** API exposed by desktop/preload.ts on window.physicsSim. */
export interface DesktopBridge {
  version: string;
  platform: string;
  openFiles(opts: { accept: string[]; multiple?: boolean }): Promise<{ name: string; path: string; bytes: ArrayBuffer }[]>;
  saveFile(name: string, bytes: ArrayBuffer): Promise<boolean>;
  watchFolder(choose: boolean): Promise<string | null>;
  onWatchedFile(cb: (file: { name: string; path: string; bytes: ArrayBuffer }) => void): void;
  onMenu(cb: (cmd: string) => void): void;
}

declare global {
  interface Window {
    physicsSim?: DesktopBridge;
  }
}
