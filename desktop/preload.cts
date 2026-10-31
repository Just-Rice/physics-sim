import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between the page and Node/Electron. The page sees
 * `window.physicsSim` (see src/platform/types.ts DesktopBridge).
 */
const versionArg = process.argv.find((a) => a.startsWith('--physics-sim-version='));

contextBridge.exposeInMainWorld('physicsSim', {
  version: versionArg ? versionArg.split('=')[1] : '',
  platform: process.platform,
  openFiles: (opts: { accept: string[]; multiple?: boolean }) => ipcRenderer.invoke('open-files', opts),
  saveFile: (name: string, bytes: ArrayBuffer) => ipcRenderer.invoke('save-file', name, bytes),
  watchFolder: (choose: boolean) => ipcRenderer.invoke('watch-folder', choose),
  onWatchedFile: (cb: (f: { name: string; path: string; bytes: ArrayBuffer }) => void) => {
    ipcRenderer.on('watched-file', (_e, f) => cb(f));
  },
  onMenu: (cb: (cmd: string) => void) => {
    ipcRenderer.on('menu', (_e, cmd) => cb(cmd));
  },
});
