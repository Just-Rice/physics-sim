import type { JointInput, ModelInput, PartInput } from '../schema';
import { box, cyl, hinge, part, sphere } from './helpers';

function brickWall(): ModelInput {
  const parts: PartInput[] = [];
  const rows = 7, cols = 6, w = 0.4, h = 0.2, d = 0.2, gap = 0.002;
  for (let r = 0; r < rows; r++) {
    const offset = r % 2 ? w / 2 : 0;
    const n = r % 2 ? cols - 1 : cols;
    for (let c = 0; c < n; c++) {
      const x = (c - (cols - 1) / 2) * (w + gap) + offset;
      parts.push(part(`b${r}_${c}`, [box([w, h, d])], { material: 'brick', position: [x, h / 2 + r * (h + gap), 0] }));
    }
  }
  return { id: 'brick-wall', name: 'Brick wall', category: 'Structures', parts };
}

function pyramid(): ModelInput {
  const parts: PartInput[] = [];
  const s = 0.3, layers = 7;
  for (let l = 0; l < layers; l++) {
    const n = layers - l;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * (s + 0.003);
      parts.push(part(`p${l}_${i}`, [box([s, s, s])], { material: l % 2 ? 'plastic-yellow' : 'plastic', position: [x, s / 2 + l * (s + 0.002), 0] }));
    }
  }
  return { id: 'pyramid', name: 'Box pyramid', category: 'Structures', parts };
}

function jenga(): ModelInput {
  const parts: PartInput[] = [];
  const L = 0.75, H = 0.15, W = 0.25, levels = 16;
  for (let l = 0; l < levels; l++) {
    for (let i = 0; i < 3; i++) {
      const off = (i - 1) * (W + 0.002);
      const y = H / 2 + l * (H + 0.001);
      const along = l % 2 === 0;
      parts.push(part(`j${l}_${i}`, [box(along ? [L, H, W] : [W, H, L])], {
        material: (l + i) % 3 === 0 ? 'wood-dark' : 'wood',
        position: along ? [0, y, off] : [off, y, 0],
        friction: 0.45,
      }));
    }
  }
  return { id: 'jenga', name: 'Jenga tower', category: 'Structures', description: 'Pull blocks out with the hand tool', parts };
}

export function dominoLine(count = 24, spacing = 0.26): ModelInput {
  const parts: PartInput[] = [];
  for (let i = 0; i < count; i++) {
    const x = (i - (count - 1) / 2) * spacing;
    parts.push(part(`d${i}`, [box([0.06, 0.42, 0.21])], {
      material: i % 2 ? 'plastic-white' : 'plastic',
      position: [x, 0.21, 0],
      // Tip the first domino so the run starts by itself.
      rotation: i === 0 ? [0, 0, -12] : [0, 0, 0],
    }));
  }
  return { id: 'domino-line', name: 'Domino line', category: 'Structures', parts };
}

function dominoSpiral(): ModelInput {
  const parts: PartInput[] = [];
  let a = 0;
  let r = 0.7;
  for (let i = 0; i < 70; i++) {
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const deg = (-a * 180) / Math.PI;
    parts.push(part(`d${i}`, [box([0.06, 0.42, 0.21])], {
      material: ['plastic', 'plastic-yellow', 'plastic-blue', 'plastic-green'][i % 4],
      position: [x, 0.21, z],
      rotation: i === 69 ? [0, deg, 14] : [0, deg, 0],
    }));
    const step = 0.26 / r;
    a += step;
    r += 0.012;
  }
  return { id: 'domino-spiral', name: 'Domino spiral', category: 'Structures', parts };
}

function bridge(): ModelInput {
  const planks = 12;
  const pw = 0.36;
  const span = planks * pw;
  const y = 1.2;
  const parts: PartInput[] = [
    part('left', [box([0.6, y, 1.4], { position: [0, -y / 2, 0] })], { material: 'stone', body: 'fixed', position: [-span / 2 - 0.3, y, 0] }),
    part('right', [box([0.6, y, 1.4], { position: [0, -y / 2, 0] })], { material: 'stone', body: 'fixed', position: [span / 2 + 0.3, y, 0] }),
  ];
  const joints: JointInput[] = [];
  for (let i = 0; i < planks; i++) {
    const x = -span / 2 + pw / 2 + i * pw;
    parts.push(part(`p${i}`, [box([pw - 0.01, 0.05, 1.0])], { material: i % 2 ? 'wood' : 'wood-dark', position: [x, y - 0.025, 0] }));
    const left = i === 0 ? 'left' : `p${i - 1}`;
    for (const z of [-0.45, 0.45]) joints.push(hinge(`p${i}`, left, [x - pw / 2, y - 0.025, z], [0, 0, 1]));
  }
  for (const z of [-0.45, 0.45]) joints.push(hinge(`p${planks - 1}`, 'right', [span / 2, y - 0.025, z], [0, 0, 1]));
  return { id: 'bridge', name: 'Plank bridge', category: 'Structures', parts, joints };
}

function galtonBoard(): ModelInput {
  const shapes = [];
  const W = 1.6, H = 2.6, gap = 0.085;
  shapes.push(box([W, H, 0.03], { position: [0, H / 2, -gap / 2 - 0.015], material: 'wood-dark' }));
  shapes.push(box([W, H, 0.02], { position: [0, H / 2, gap / 2 + 0.01], material: 'glass', visible: true }));
  shapes.push(box([0.04, H, gap + 0.05], { position: [-W / 2, H / 2, 0], material: 'wood-dark' }));
  shapes.push(box([0.04, H, gap + 0.05], { position: [W / 2, H / 2, 0], material: 'wood-dark' }));
  shapes.push(box([W, 0.04, gap + 0.05], { position: [0, 0.02, 0], material: 'wood-dark' }));
  // funnel
  shapes.push(box([0.75, 0.03, gap], { position: [-0.36, 2.3, 0], rotation: [0, 0, -28], material: 'wood' }));
  shapes.push(box([0.75, 0.03, gap], { position: [0.36, 2.3, 0], rotation: [0, 0, 28], material: 'wood' }));
  // pegs
  const rows = 11, sp = 0.11;
  for (let r = 0; r < rows; r++) {
    const n = r + 3;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * sp;
      if (Math.abs(x) > W / 2 - 0.05) continue;
      shapes.push(cyl(0.012, gap, { rotation: [90, 0, 0], position: [x, 2.0 - r * sp * 0.9, 0], material: 'chrome' }));
    }
  }
  // bins
  for (let i = -7; i <= 7; i++) shapes.push(box([0.012, 0.75, gap], { position: [i * sp, 0.415, 0], material: 'wood' }));
  return {
    id: 'galton-board', name: 'Galton board', category: 'Structures',
    description: 'Balls bounce through pegs into a bell curve',
    parts: [part('board', shapes, { material: 'wood-dark', body: 'fixed' })],
  };
}

export function galtonBalls(count = 120): ModelInput {
  const parts: PartInput[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 10);
    const col = i % 10;
    parts.push(part(`b${i}`, [sphere(0.03)], {
      material: 'steel', position: [(col - 4.5) * 0.068 + (row % 2) * 0.02, 2.65 + row * 0.07, 0], restitution: 0.3, friction: 0.1, ccd: false,
    }));
  }
  return { id: 'galton-balls', name: 'Galton balls', category: 'Structures', parts };
}

function glassTank(): ModelInput {
  const W = 2.4, D = 1.2, H = 1.0, t = 0.04;
  return {
    id: 'glass-tank', name: 'Glass tank', category: 'Structures', description: 'Open-top tank for water',
    parts: [part('tank', [
      box([W + 2 * t, t, D + 2 * t], { position: [0, t / 2, 0] }),
      box([t, H, D + 2 * t], { position: [-W / 2 - t / 2, H / 2 + t, 0] }),
      box([t, H, D + 2 * t], { position: [W / 2 + t / 2, H / 2 + t, 0] }),
      box([W, H, t], { position: [0, H / 2 + t, -D / 2 - t / 2] }),
      box([W, H, t], { position: [0, H / 2 + t, D / 2 + t / 2] }),
    ], { material: 'glass', body: 'fixed' })],
  };
}

export const structures: ModelInput[] = [brickWall(), pyramid(), jenga(), dominoLine(), dominoSpiral(), bridge(), galtonBoard(), glassTank()];
