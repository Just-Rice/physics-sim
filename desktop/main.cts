import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ORIGIN, registerAppProtocol, registerSchemePrivileges } from './protocol.cjs';
import { FolderWatcher } from './watch.cjs';
import { buildMenu } from './menu.cjs';

/**
 * Physics Sim desktop shell. It serves the same web build as GitHub Pages,
 * adds cross-origin isolation (multithreaded physics), native menus and
 * dialogs, and a watched Blender export folder that hot-reloads models.
 */

interface Config {
  watchFolder?: string;
  uncappedFps?: boolean;
}

const configPath = () => path.join(app.getPath('userData'), 'config.json');
function readConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Config;
  } catch {
    return {};
  }
}
function writeConfig(c: Config): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(c, null, 2));
}

registerSchemePrivileges();

// Prefer the discrete GPU and don't let Chromium blocklist it.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('force_high_performance_gpu');
let config: Config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8')) as Config;
} catch {
  config = {};
}
if (config.uncappedFps) {
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}

let win: BrowserWindow | null = null;
const watcher = new FolderWatcher((f) => win?.webContents.send('watched-file', f));

function defaultWatchFolder(): string {
  return path.join(app.getPath('documents'), 'Physics Sim', 'Blender');
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0d1016',
    title: 'Physics Sim',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      additionalArguments: [`--physics-sim-version=${app.getVersion()}`],
    },
  });
  win.once('ready-to-show', () => win?.show());
  // Lock navigation to the app; open web links in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  buildMenu(win, {
    uncappedFps: !!config.uncappedFps,
    onToggleUncapped: (on) => {
      config = { ...readConfig(), uncappedFps: on };
      writeConfig(config);
    },
  });
  win.loadURL(`${APP_ORIGIN}/index.html`);
  win.on('closed', () => {
    win = null;
  });
}

function registerIpc(): void {
  ipcMain.handle('open-files', async (_e, opts: { accept: string[]; multiple?: boolean }) => {
    if (!win) return [];
    const exts = (opts?.accept ?? []).map((a) => a.replace(/^\./, ''));
    const r = await dialog.showOpenDialog(win, {
      properties: opts?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: exts.length ? [{ name: 'Supported files', extensions: exts }] : [],
    });
    if (r.canceled) return [];
    return Promise.all(r.filePaths.map(async (p) => {
      const buf = await fs.promises.readFile(p);
      return { name: path.basename(p), path: p, bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }));
  });

  ipcMain.handle('save-file', async (_e, name: string, bytes: ArrayBuffer) => {
    if (!win) return false;
    const dir = /\.png$/i.test(name) ? app.getPath('pictures') : app.getPath('documents');
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(dir, name) });
    if (r.canceled || !r.filePath) return false;
    await fs.promises.writeFile(r.filePath, Buffer.from(bytes));
    return true;
  });

  ipcMain.handle('watch-folder', async (_e, choose: boolean) => {
    let folder = readConfig().watchFolder ?? defaultWatchFolder();
    if (choose && win) {
      fs.mkdirSync(folder, { recursive: true });
      const r = await dialog.showOpenDialog(win, {
        title: 'Folder for Blender exports',
        message: 'Physics Sim imports or reloads models whenever a .glb in this folder changes.',
        defaultPath: folder,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      folder = r.filePaths[0];
      writeConfig({ ...readConfig(), watchFolder: folder });
    }
    watcher.start(folder);
    return folder;
  });
}

app.whenReady().then(() => {
  // Packaged: resources/app.asar/dist; development: ../dist next to desktop-dist.
  registerAppProtocol(path.join(__dirname, '..', 'dist'));
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  registerIpc();
  createWindow();
  try {
    watcher.start(readConfig().watchFolder ?? defaultWatchFolder());
  } catch (err) {
    console.warn('Could not watch the Blender folder', err);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  watcher.stop();
  if (process.platform !== 'darwin') app.quit();
});
