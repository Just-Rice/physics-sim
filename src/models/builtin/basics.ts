import type { ModelInput } from '../schema';
import { box, capsule, cone, cyl, mesh, single, sphere } from './helpers';

export const basics: ModelInput[] = [
  { id: 'cube', name: 'Cube', category: 'Basics', parts: single([box([0.4, 0.4, 0.4])], { material: 'plastic' }) },
  { id: 'sphere', name: 'Ball', category: 'Basics', parts: single([sphere(0.2)], { material: 'plastic-blue' }) },
  { id: 'cylinder', name: 'Cylinder', category: 'Basics', parts: single([cyl(0.18, 0.4)], { material: 'plastic-green' }) },
  { id: 'capsule', name: 'Capsule', category: 'Basics', parts: single([capsule(0.14, 0.6)], { material: 'plastic-yellow' }) },
  { id: 'cone', name: 'Cone', category: 'Basics', parts: single([cone(0.22, 0.45)], { material: 'plastic' }) },
  { id: 'crate', name: 'Wooden crate', category: 'Basics', parts: single([box([0.5, 0.5, 0.5])], { material: 'wood' }) },
  { id: 'plank', name: 'Plank', category: 'Basics', parts: single([box([2, 0.06, 0.3])], { material: 'wood' }) },
  { id: 'domino', name: 'Domino', category: 'Basics', parts: single([box([0.06, 0.42, 0.21])], { material: 'plastic-white' }) },
  { id: 'brick', name: 'Brick', category: 'Basics', parts: single([box([0.4, 0.2, 0.2])], { material: 'brick' }) },
  {
    id: 'steel-ball', name: 'Steel ball', category: 'Basics',
    parts: single([sphere(0.12)], { material: 'steel', ccd: true }),
  },
  {
    id: 'ramp', name: 'Ramp (fixed)', category: 'Basics',
    description: 'A fixed 15° ramp',
    parts: single([box([3, 0.1, 1.2], { rotation: [0, 0, 15], position: [0, 0.39, 0] })], { material: 'wood-dark', body: 'fixed' }),
  },
  {
    id: 'wall-fixed', name: 'Wall (fixed)', category: 'Basics',
    parts: single([box([0.2, 1.5, 3])], { material: 'concrete', body: 'fixed' }),
  },
  {
    id: 'studio-backdrop', name: 'Studio backdrop', category: 'Basics',
    description: 'Seamless white cyclorama for product-style renders',
    parts: single([mesh('proc:cyclorama', { collider: 'trimesh', position: [0, 0.002, 0] })], { material: { color: '#f2f2ef', roughness: 0.75, density: 1000 }, body: 'fixed' }),
  },
  {
    id: 'bowl', name: 'Bowl (fixed)', category: 'Basics',
    description: 'Concave bowl using an exact triangle-mesh collider',
    parts: single([mesh('proc:bowl', { collider: 'trimesh', scale: [2, 2, 2] })], { material: 'marble', body: 'fixed' }),
  },
];

export const materialsShowcase: ModelInput[] = [
  { id: 'glass-sphere', name: 'Glass sphere', category: 'Materials', parts: single([sphere(0.25)], { material: 'glass' }) },
  { id: 'glass-cube', name: 'Glass cube', category: 'Materials', parts: single([box([0.4, 0.4, 0.4])], { material: 'glass-tinted' }) },
  { id: 'chrome-ball', name: 'Chrome ball', category: 'Materials', parts: single([sphere(0.2)], { material: 'chrome' }) },
  { id: 'gold-bar', name: 'Gold bar', category: 'Materials', parts: single([box([0.3, 0.09, 0.13])], { material: 'gold' }) },
  { id: 'rubber-ball', name: 'Rubber ball', category: 'Materials', parts: single([sphere(0.15)], { material: 'rubber-red' }) },
  { id: 'ice-cube', name: 'Ice block', category: 'Materials', parts: single([box([0.3, 0.3, 0.3])], { material: 'ice' }) },
  { id: 'marble-sphere', name: 'Marble sphere', category: 'Materials', parts: single([sphere(0.2)], { material: 'marble' }) },
  { id: 'diamond', name: 'Diamond', category: 'Materials', parts: single([mesh('proc:gem', { scale: [0.8, 1.1, 0.8] })], { material: 'diamond' }) },
  { id: 'copper-cylinder', name: 'Copper cylinder', category: 'Materials', parts: single([cyl(0.12, 0.35)], { material: 'copper' }) },
  { id: 'foam-block', name: 'Foam block', category: 'Materials', parts: single([box([0.5, 0.3, 0.5])], { material: 'foam' }) },
  { id: 'frosted-sphere', name: 'Frosted glass', category: 'Materials', parts: single([sphere(0.22)], { material: 'frosted-glass' }) },
  {
    id: 'neon-tube', name: 'Neon tube', category: 'Materials',
    description: 'Emissive: lights up the scene when ray tracing',
    parts: single([capsule(0.05, 1.2, { rotation: [0, 0, 90] })], { material: 'neon' }),
  },
  { id: 'neon-ring', name: 'Neon ring', category: 'Materials', parts: single([mesh('proc:torus', { scale: [1, 1, 1] })], { material: 'neon-pink' }) },
  { id: 'lamp-cube', name: 'Light cube', category: 'Materials', parts: single([box([0.25, 0.25, 0.25])], { material: 'lamp' }) },
  { id: 'teapot', name: 'Teapot', category: 'Materials', parts: single([mesh('proc:teapot')], { material: 'chrome' }) },
  { id: 'torus-knot', name: 'Glass knot', category: 'Materials', parts: single([mesh('proc:torusknot')], { material: 'glass-tinted' }) },
];
