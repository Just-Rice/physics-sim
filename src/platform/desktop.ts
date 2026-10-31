import type { DesktopBridge, MenuCommand, Platform } from './types';

/** Platform backed by the Electron preload bridge (window.physicsSim). */
export function createDesktopPlatform(bridge: DesktopBridge): Platform {
  return {
    kind: 'desktop',
    hardwareThreads: navigator.hardwareConcurrency || 8,
    openFiles: (opts) => bridge.openFiles(opts),
    async saveFile(name, data) {
      return bridge.saveFile(name, await data.arrayBuffer());
    },
    watchFolder: (choose) => bridge.watchFolder(choose),
    onWatchedFile: (cb) => bridge.onWatchedFile(cb),
    onMenu: (cb) => bridge.onMenu((cmd) => cb(cmd as MenuCommand)),
  };
}
