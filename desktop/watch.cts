import fs from 'node:fs';
import path from 'node:path';

export interface WatchedFile {
  name: string;
  path: string;
  bytes: ArrayBuffer;
}

const MODEL_FILE = /\.(glb|gltf)$/i;

/**
 * Watches a folder for Blender exports. Uses fs.watch (FSEvents on macOS),
 * debounces bursts, and waits until the file stops growing before reading.
 */
export class FolderWatcher {
  private watcher: fs.FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  folder: string | null = null;

  constructor(private onFile: (f: WatchedFile) => void) {}

  start(folder: string): void {
    this.stop();
    fs.mkdirSync(folder, { recursive: true });
    this.folder = folder;
    this.watcher = fs.watch(folder, { recursive: process.platform !== 'linux' }, (_event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (!MODEL_FILE.test(name)) return;
      const full = path.join(folder, name);
      clearTimeout(this.timers.get(full));
      this.timers.set(full, setTimeout(() => this.read(full), 350));
    });
    this.watcher.on('error', (err) => console.warn('watch error', err));
  }

  private async read(full: string, attempt = 0): Promise<void> {
    this.timers.delete(full);
    try {
      const a = await fs.promises.stat(full);
      await new Promise((r) => setTimeout(r, 150));
      const b = await fs.promises.stat(full);
      if (a.size !== b.size && attempt < 10) return this.read(full, attempt + 1);
      const buf = await fs.promises.readFile(full);
      const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      this.onFile({ name: path.basename(full), path: full, bytes });
    } catch {
      // Deleted or renamed meanwhile: ignore.
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
