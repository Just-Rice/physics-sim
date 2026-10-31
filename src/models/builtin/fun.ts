import type { JointInput, ModelInput, PartInput } from '../schema';
import { ball, capsule, hinge, mesh, part, sphere } from './helpers';

function ragdoll(): ModelInput {
  const skin = { preset: 'plastic', color: '#f0b48a' };
  const shirt = 'plastic-blue';
  const pants = { preset: 'fabric', color: '#2d3a4f', density: 1000 };
  const parts: PartInput[] = [
    part('torso', [capsule(0.16, 0.6)], { material: shirt, position: [0, 1.25, 0] }),
    part('pelvis', [capsule(0.14, 0.32, { rotation: [0, 0, 90] })], { material: pants, position: [0, 0.88, 0] }),
    part('head', [sphere(0.13)], { material: skin, position: [0, 1.72, 0] }),
    part('uarmL', [capsule(0.055, 0.32, { rotation: [0, 0, 90] })], { material: shirt, position: [-0.36, 1.45, 0] }),
    part('larmL', [capsule(0.05, 0.3, { rotation: [0, 0, 90] })], { material: skin, position: [-0.68, 1.45, 0] }),
    part('uarmR', [capsule(0.055, 0.32, { rotation: [0, 0, 90] })], { material: shirt, position: [0.36, 1.45, 0] }),
    part('larmR', [capsule(0.05, 0.3, { rotation: [0, 0, 90] })], { material: skin, position: [0.68, 1.45, 0] }),
    part('ulegL', [capsule(0.07, 0.42)], { material: pants, position: [-0.1, 0.6, 0] }),
    part('llegL', [capsule(0.06, 0.42)], { material: pants, position: [-0.1, 0.2, 0] }),
    part('ulegR', [capsule(0.07, 0.42)], { material: pants, position: [0.1, 0.6, 0] }),
    part('llegR', [capsule(0.06, 0.42)], { material: pants, position: [0.1, 0.2, 0] }),
  ];
  for (const p of parts) p.angularDamping = 0.6;
  const joints: JointInput[] = [
    ball('head', 'torso', [0, 1.6, 0]),
    ball('pelvis', 'torso', [0, 0.95, 0]),
    ball('uarmL', 'torso', [-0.2, 1.45, 0]),
    hinge('larmL', 'uarmL', [-0.52, 1.45, 0], [0, 1, 0], { limits: [-140, 0] }),
    ball('uarmR', 'torso', [0.2, 1.45, 0]),
    hinge('larmR', 'uarmR', [0.52, 1.45, 0], [0, 1, 0], { limits: [0, 140] }),
    ball('ulegL', 'pelvis', [-0.1, 0.82, 0]),
    hinge('llegL', 'ulegL', [-0.1, 0.4, 0], [1, 0, 0], { limits: [0, 140] }),
    ball('ulegR', 'pelvis', [0.1, 0.82, 0]),
    hinge('llegR', 'ulegR', [0.1, 0.4, 0], [1, 0, 0], { limits: [0, 140] }),
  ];
  return { id: 'ragdoll', name: 'Ragdoll', category: 'Fun', parts, joints };
}

export function bowlingSet(): ModelInput {
  const parts: PartInput[] = [];
  const s = 0.305;
  let k = 0;
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i <= row; i++) {
      const z = (i - row / 2) * s;
      const x = row * s * 0.866;
      parts.push(part(`pin${k++}`, [mesh('proc:pin', { collider: 'hull' })], {
        material: { preset: 'plastic-white', density: 800, restitution: 0.5, friction: 0.35 },
        position: [x, 0.19, z],
      }));
    }
  }
  return { id: 'bowling-pins', name: 'Bowling pins', category: 'Fun', parts };
}

export const bowlingBall: ModelInput = {
  id: 'bowling-ball', name: 'Bowling ball', category: 'Fun',
  parts: [part('ball', [sphere(0.109)], { material: { color: '#1d2b78', roughness: 0.08, clearcoat: 1, density: 1180, friction: 0.25, restitution: 0.2 }, ccd: true })],
};

export const fun: ModelInput[] = [
  ragdoll(),
  bowlingSet(),
  bowlingBall,
  { id: 'teapot-marble', name: 'Marble teapot', category: 'Fun', parts: [part('body', [mesh('proc:teapot')], { material: 'marble' })] },
  { id: 'beach-ball', name: 'Beach ball', category: 'Fun', parts: [part('body', [sphere(0.3)], { material: { preset: 'plastic-yellow', density: 20, restitution: 0.75, friction: 0.6 } })] },
];
