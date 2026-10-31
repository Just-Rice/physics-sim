import { h, modal } from './dom';

const keys: [string, string][] = [
  ['1 – 6', 'Hand · Spawn · Cannon · Explode · Attract · Erase'],
  ['Space', 'Pause / resume'],
  ['.', 'Step one frame while paused'],
  ['R', 'Reset the scenario'],
  ['T', 'Toggle ray tracing'],
  ['B / Esc', 'Model Builder / back to Play'],
  ['L', 'Show / hide the library'],
  ['G', 'Show / hide settings'],
  ['F', 'Focus the camera on the selection'],
  ['Del', 'Delete the selection'],
  ['P', 'Save an image'],
  ['H or ?', 'This help'],
];

const mouse: [string, string][] = [
  ['Left drag (empty)', 'Orbit the camera'],
  ['Right drag', 'Pan'],
  ['Scroll', 'Zoom (or push/pull while grabbing)'],
  ['Alt + drag', 'Orbit, even over objects'],
  ['Drop a file', 'Import .glb .gltf .obj .stl .physmodel.json'],
];

export function showHelp(platformKind: 'web' | 'desktop'): void {
  const grid = (rows: [string, string][]) => h('div', { class: 'help-grid' }, ...rows.flatMap(([k, d]) => [h('kbd', {}, k), h('div', {}, d)]));
  const body = h('div', {},
    h('h2', {}, 'Physics Sim'),
    h('p', { class: 'sub' }, 'Rigid bodies, joints, cloth, soft bodies, fluids and orbital gravity — with a path-traced renderer for photo-real light.'),
    h('div', { class: 'help-cols' },
      h('div', {}, h('h3', {}, 'Keyboard'), grid(keys)),
      h('div', {}, h('h3', {}, 'Mouse'), grid(mouse),
        h('h3', {}, 'Ray tracing'),
        h('div', { class: 'insp-sub', style: 'font-size:12px;line-height:1.5' },
          'Turn on Ray tracing for physically based light: soft shadows, reflections, refraction through glass and water, and emissive lights. ',
          'While things move it renders a fast, noisier preview; pause (Space) and it converges to a clean image. Settings → Ray tracing has depth of field (click to focus) and photo export.'),
        h('h3', {}, 'Making models'),
        h('div', { class: 'insp-sub', style: 'font-size:12px;line-height:1.5' },
          'Use Build mode to assemble shapes, joints and motors, or import a .glb exported from Blender. ',
          platformKind === 'desktop' ? 'The Mac app can watch a folder and live-reload models whenever Blender re-exports them.' : 'See docs/BLENDER.md for the Blender add-on and naming conventions.'),
      )),
    h('div', { class: 'footer' }, h('button', { class: 'btn primary', onclick: () => m.close() }, 'Got it')),
  );
  const m = modal(body);
}
