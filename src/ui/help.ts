import { h, isTouch, modal } from './dom';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = isMac ? '⌘' : 'Ctrl';

const keys: [string, string][] = [
  ['1 – 6', 'Hand · Place · Cannon · Explode · Attract · Erase'],
  ['Space', 'Pause / resume'],
  ['.', 'Step one frame while paused'],
  [`${mod} Z  /  ${mod} ⇧ Z`, 'Undo / redo'],
  ['R', 'Reset the scene to how it started'],
  ['T', 'Ray tracing on / off'],
  ['B  /  Esc', 'Model Builder / back to Play'],
  ['L  /  G', 'Library / settings'],
  ['F', 'Point the camera at the selection'],
  ['Del', 'Delete the selection (⇧ Del clears everything)'],
  ['P', 'Save a picture'],
  ['H  or  ?', 'This help'],
];

const mouse: [string, string][] = [
  ['Drag an object', 'Grab it — let go while moving to throw'],
  ['Drag empty space', 'Look around'],
  ['Right-drag', 'Pan the camera'],
  ['Scroll', 'Zoom (while grabbing: push / pull)'],
  ['Alt + drag', 'Look around, even over objects'],
  ['Drag from the library', 'Drop a model exactly where you want it'],
  ['Double-click a model', 'Drop it in the middle of the view'],
  ['Drop a file on the window', 'Import .glb .gltf .obj .stl, a model or a scene'],
];

const touchRows: [string, string][] = [
  ['Drag an object', 'Grab it — let go while moving to throw'],
  ['Tap an object', 'Show its details (mass, speed, material…)'],
  ['Drag empty space', 'Look around'],
  ['Two fingers', 'Pinch to zoom, drag to pan and turn'],
  ['Tap a model', 'In the library: pick it, then tap the scene to place it'],
  ['Hold a model', 'More options: drop in view, edit in Build, export'],
  ['↶ ↷', 'Undo / redo (bottom bar)'],
];

export function showHelp(platformKind: 'web' | 'desktop', onTour?: () => void): void {
  const touch = isTouch();
  const grid = (rows: [string, string][]) => h('div', { class: 'help-grid' }, ...rows.flatMap(([k, d]) => [h('kbd', {}, k), h('div', {}, d)]));
  // Phones and tablets lead with gestures; the keyboard table is still there for a paired keyboard.
  const keyboard = touch
    ? h('details', { class: 'help-keys' }, h('summary', {}, 'Keyboard shortcuts'), grid(keys))
    : h('div', {}, h('h3', {}, 'Keyboard'), grid(keys));
  const body = h('div', {},
    h('h2', {}, 'Physics Sim — help'),
    h('p', { class: 'sub' }, 'Rigid bodies, joints, cloth, jelly, water and orbital gravity — with ray tracing for photo-real light.'),
    h('div', { class: 'help-cols' },
      touch
        ? h('div', {}, h('h3', {}, 'Touch'), grid(touchRows))
        : h('div', {}, h('h3', {}, 'Mouse & touch'), grid(mouse),
          h('h3', {}, 'Touch screens'),
          h('div', { class: 'insp-sub help-text' }, 'One finger uses the current tool; two fingers turn, pan and zoom the camera.')),
      h('div', {}, keyboard,
        h('h3', {}, 'Ray tracing'),
        h('div', { class: 'insp-sub help-text' },
          'Turn it on for soft shadows, reflections, glass and glowing lights. While things move you see a quick, grainy preview; ',
          'press Render still (or Space) and the picture sharpens. Pick Fast / Balanced / Best quality on the badge at the top.'),
        h('h3', {}, 'Making models'),
        h('div', { class: 'insp-sub help-text' },
          'Build mode snaps shapes together with hinges, springs and motors. You can also import a .glb from Blender. ',
          platformKind === 'desktop' ? 'The Mac app reloads a model every time Blender re-exports it into the live-link folder.' : 'The Blender add-on and naming tips are in docs/BLENDER.md.'),
      )),
    h('div', { class: 'footer' },
      onTour ? h('button', { class: 'btn', onclick: () => { m.close(); onTour(); } }, 'Replay the tour') : null,
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Got it')),
  );
  const m = modal(body);
}
