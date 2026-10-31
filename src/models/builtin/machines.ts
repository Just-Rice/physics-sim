import type { JointInput, MaterialRef, ModelInput, PartInput } from '../schema';
import { ball, box, capsule, cyl, hinge, part, sphere } from './helpers';

const cradleSteel: MaterialRef = { color: '#d7dbe0', metalness: 1, roughness: 0.12, density: 7850, friction: 0, restitution: 0.995 };

function newtonsCradle(): ModelInput {
  const n = 5;
  const r = 0.1;
  const pivotY = 1.2;
  const len = 0.7;
  const parts: PartInput[] = [
    part('frame', [
      box([1.5, 0.06, 0.6], { position: [0, 0.03, 0] }),
      box([0.05, 1.25, 0.05], { position: [-0.7, 0.655, 0] }),
      box([0.05, 1.25, 0.05], { position: [0.7, 0.655, 0] }),
      box([1.45, 0.04, 0.05], { position: [0, 1.25, 0] }),
    ], { material: 'wood-dark', body: 'fixed' }),
  ];
  const joints: JointInput[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * (2 * r + 0.0005);
    const id = `ball${i}`;
    parts.push(part(id, [
      sphere(r, { position: [0, -len, 0], material: cradleSteel }),
      cyl(0.004, len - r, { position: [0, -(len - r) / 2, 0], collide: false, material: 'steel' }),
    ], {
      position: [x, pivotY, 0],
      // Raise the first ball so the cradle starts swinging on spawn.
      rotation: i === 0 ? [0, 0, -50] : [0, 0, 0],
      material: cradleSteel,
      angularDamping: 0,
      ccd: true,
    }));
    joints.push(hinge(id, 'frame', [x, pivotY, 0], [0, 0, 1]));
  }
  return { id: 'newtons-cradle', name: "Newton's cradle", category: 'Machines', description: 'Momentum transfer through a row of steel balls', parts, joints };
}

function pendulum(): ModelInput {
  return {
    id: 'pendulum', name: 'Pendulum', category: 'Machines',
    parts: [
      part('frame', [
        box([1.6, 0.1, 0.9], { position: [0, 0.05, -0.1] }),
        box([0.08, 2.3, 0.08], { position: [0, 1.2, -0.4] }),
        box([0.08, 0.08, 0.44], { position: [0, 2.28, -0.2] }),
      ], { material: 'steel', body: 'fixed' }),
      part('arm', [
        capsule(0.015, 1.6, { position: [0, -0.8, 0], collide: false }),
        sphere(0.15, { position: [0, -1.6, 0] }),
      ], { material: 'chrome', position: [0, 2.24, 0], rotation: [0, 0, 55], angularDamping: 0 }),
    ],
    joints: [hinge('arm', 'frame', [0, 2.24, 0], [0, 0, 1])],
  };
}

function car(): ModelInput {
  const wheel = (id: string, x: number, z: number): PartInput =>
    part(id, [cyl(0.25, 0.16, { rotation: [90, 0, 0] }), cyl(0.12, 0.17, { rotation: [90, 0, 0], material: 'chrome', collide: false })],
      { material: 'rubber', position: [x, 0.25, z], angularDamping: 0.02 });
  return {
    id: 'car', name: 'Motor car', category: 'Machines',
    description: 'Rear-wheel drive with hinge motors',
    parts: [
      part('chassis', [
        box([1.6, 0.18, 0.7], { position: [0, 0, 0] }),
        box([0.8, 0.28, 0.62], { position: [-0.1, 0.23, 0], material: { preset: 'glass-tinted', density: 150 } }),
        box([0.05, 0.05, 0.5], { position: [0.82, 0.02, 0], material: 'lamp', collide: false }),
      ], { material: 'plastic', position: [0, 0.42, 0], density: 300 }),
      wheel('wfl', 0.55, 0.45), wheel('wfr', 0.55, -0.45), wheel('wrl', -0.55, 0.45), wheel('wrr', -0.55, -0.45),
    ],
    joints: [
      hinge('wfl', 'chassis', [0.55, 0.25, 0.45], [0, 0, 1]),
      hinge('wfr', 'chassis', [0.55, 0.25, -0.45], [0, 0, 1]),
      hinge('wrl', 'chassis', [-0.55, 0.25, 0.45], [0, 0, 1], { motor: { velocity: -9, force: 40 } }),
      hinge('wrr', 'chassis', [-0.55, 0.25, -0.45], [0, 0, 1], { motor: { velocity: -9, force: 40 } }),
    ],
  };
}

function windmill(): ModelInput {
  const blades = [0, 90, 180, 270].map((a) => box([0.16, 1.4, 0.03], {
    position: [Math.cos(((a + 90) * Math.PI) / 180) * 0.75, Math.sin(((a + 90) * Math.PI) / 180) * 0.75, 0],
    rotation: [0, 0, a],
  }));
  return {
    id: 'windmill', name: 'Windmill', category: 'Machines', description: 'Motorised rotor — drop things into it',
    parts: [
      part('tower', [box([0.3, 3, 0.3], { position: [0, 1.5, -0.25] }), box([1, 0.1, 1], { position: [0, 0.05, -0.25] })], { material: 'concrete', body: 'fixed' }),
      part('rotor', [cyl(0.12, 0.2, { rotation: [90, 0, 0] }), ...blades], { material: 'wood', position: [0, 3, 0] }),
    ],
    joints: [hinge('rotor', 'tower', [0, 3, 0], [0, 0, 1], { motor: { velocity: 1.6, force: 400 } })],
  };
}

function seesaw(): ModelInput {
  return {
    id: 'seesaw', name: 'Seesaw', category: 'Machines',
    parts: [
      part('base', [box([0.2, 0.45, 0.5], { position: [0, 0.225, 0] })], { material: 'steel', body: 'fixed' }),
      part('plank', [box([3, 0.08, 0.45]), box([0.06, 0.25, 0.45], { position: [1.47, 0.16, 0] }), box([0.06, 0.25, 0.45], { position: [-1.47, 0.16, 0] })], { material: 'wood', position: [0, 0.5, 0] }),
    ],
    joints: [hinge('plank', 'base', [0, 0.5, 0], [0, 0, 1], { limits: [-18, 18] })],
  };
}

function catapult(): ModelInput {
  return {
    id: 'catapult', name: 'Catapult', category: 'Machines',
    description: 'A falling counterweight flings the ball',
    parts: [
      part('base', [box([0.25, 0.6, 0.5], { position: [0, 0.3, 0] })], { material: 'steel', body: 'fixed' }),
      part('arm', [
        box([3.2, 0.08, 0.4], { position: [0.6, 0, 0] }),
        box([0.05, 0.18, 0.4], { position: [2.18, 0.12, 0] }),
        box([0.05, 0.18, 0.4], { position: [1.8, 0.12, 0] }),
      ], { material: 'wood', position: [0, 0.65, 0], rotation: [0, 0, -9], density: 400 }),
      part('ball', [sphere(0.13)], { material: 'rubber-red', position: [2.0, 0.6, 0] }),
      part('weight', [box([0.5, 0.5, 0.5])], { material: 'steel', position: [-0.8, 3.2, 0] }),
    ],
    joints: [hinge('arm', 'base', [0, 0.65, 0], [0, 0, 1], { limits: [-12, 50] })],
  };
}

function chain(): ModelInput {
  const links = 10;
  const L = 0.24;
  const parts: PartInput[] = [part('hook', [box([0.3, 0.1, 0.3])], { material: 'steel', body: 'fixed', position: [0, 3.05, 0] })];
  const joints: JointInput[] = [];
  for (let i = 0; i < links; i++) {
    const y = 3 - L / 2 - i * L;
    parts.push(part(`l${i}`, [capsule(0.03, L)], { material: 'steel', position: [0, y, 0], angularDamping: 0.2 }));
    joints.push(ball(`l${i}`, i === 0 ? 'hook' : `l${i - 1}`, [0, y + L / 2, 0]));
  }
  parts.push(part('weight', [sphere(0.15)], { material: 'steel', position: [0, 3 - links * L - 0.12, 0] }));
  joints.push(ball('weight', `l${links - 1}`, [0, 3 - links * L, 0]));
  return { id: 'chain', name: 'Hanging chain', category: 'Machines', parts, joints };
}

export function wreckingBall(swingSpeed = 0): ModelInput {
  const links = 8;
  const L = 0.5;
  const top = 5.4;
  const pivotX = 1.6;
  const parts: PartInput[] = [
    part('crane', [
      box([1.2, 0.3, 1.2], { position: [0, 0.15, 0] }),
      box([0.3, 5.4, 0.3], { position: [0, 2.85, 0] }),
      box([2.1, 0.2, 0.2], { position: [0.85, 5.5, 0] }),
    ], { material: 'plastic-yellow', body: 'fixed' }),
  ];
  const joints: JointInput[] = [];
  // Links swing about the pivot; an initial angular velocity gives every link a matching linear velocity.
  const omega = swingSpeed / (links * L + 0.5);
  for (let i = 0; i < links; i++) {
    const y = top - L / 2 - i * L;
    const r = top - y;
    parts.push(part(`l${i}`, [capsule(0.04, L)], {
      material: 'steel', position: [pivotX, y, 0], angularDamping: 0.1,
      initialVelocity: [omega * r, 0, 0], initialAngularVelocity: [0, 0, omega],
    }));
    joints.push(ball(`l${i}`, i === 0 ? 'crane' : `l${i - 1}`, [pivotX, y + L / 2, 0]));
  }
  const by = top - links * L - 0.45;
  parts.push(part('ball', [sphere(0.45)], {
    material: 'steel', position: [pivotX, by, 0], ccd: true,
    initialVelocity: [omega * (top - by), 0, 0], initialAngularVelocity: [0, 0, omega],
  }));
  joints.push(ball('ball', `l${links - 1}`, [pivotX, top - links * L, 0]));
  return { id: swingSpeed ? 'wrecking-ball-swinging' : 'wrecking-ball', name: 'Wrecking ball', category: 'Machines', parts, joints };
}

export const machines: ModelInput[] = [
  car(),
  pendulum(),
  newtonsCradle(),
  wreckingBall(),
  windmill(),
  seesaw(),
  catapult(),
  chain(),
];
