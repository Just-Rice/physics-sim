import { Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

export interface MenuOptions {
  uncappedFps: boolean;
  onToggleUncapped(on: boolean): void;
}

/** Native menus. App commands are forwarded to the page as 'menu' events. */
export function buildMenu(win: BrowserWindow, opts: MenuOptions): void {
  const send = (cmd: string) => () => win.webContents.send('menu', cmd);
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Import Model…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: 'Save Scene…', accelerator: 'CmdOrCtrl+S', click: send('save-scene') },
        { label: 'Load Scene…', accelerator: 'CmdOrCtrl+Shift+O', click: send('load-scene') },
        { type: 'separator' },
        { label: 'Render Photo…', accelerator: 'CmdOrCtrl+Shift+P', click: send('render-photo') },
        { type: 'separator' },
        { label: 'Blender Live Link Folder…', click: send('watch-folder') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Ray Tracing', accelerator: 'CmdOrCtrl+Shift+T', click: send('toggle-raytracing') },
        { label: 'Play Mode', accelerator: 'CmdOrCtrl+1', click: send('play-mode') },
        { label: 'Model Builder', accelerator: 'CmdOrCtrl+2', click: send('build-mode') },
        { type: 'separator' },
        {
          label: 'Uncapped Frame Rate (applies after restart)',
          type: 'checkbox',
          checked: opts.uncappedFps,
          click: (item) => opts.onToggleUncapped(item.checked),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Simulation',
      submenu: [
        { label: 'Pause / Resume (Space)', click: send('toggle-pause') },
        { label: 'Step Frame (.)', click: send('step') },
        { label: 'Reset Scenario (R)', click: send('reset') },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard & Mouse', click: send('help') },
        { label: 'Blender Guide', click: () => shell.openExternal('https://github.com/Just-Rice/physics-sim/blob/main/docs/BLENDER.md') },
        { label: 'Project on GitHub', click: () => shell.openExternal('https://github.com/Just-Rice/physics-sim') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
