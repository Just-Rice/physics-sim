import type { ModelInput } from '../schema';
import { box, cyl, part } from './helpers';

export const softAndFluid: ModelInput[] = [
  {
    id: 'flag', name: 'Flag on pole', category: 'Soft & Fluid', description: 'Cloth pinned to a pole — turn on wind',
    parts: [part('pole', [cyl(0.035, 3.2, { position: [0, 1.6, 0] }), box([0.5, 0.06, 0.5], { position: [0, 0.03, 0] })], { material: 'aluminium', body: 'fixed' })],
    softParts: [{
      type: 'cloth', id: 'flag', name: 'Flag', position: [0.75, 2.65, 0], size: [1.5, 1.0], resolution: [30, 20],
      pins: 'left-edge', attachTo: 'pole', material: 'fabric', bend: 0.05,
    }],
  },
  {
    id: 'curtain', name: 'Curtain', category: 'Soft & Fluid',
    parts: [part('rod', [cyl(0.03, 2.8, { rotation: [0, 0, 90] }), cyl(0.03, 2.6, { position: [-1.4, -1.3, 0] }), cyl(0.03, 2.6, { position: [1.4, -1.3, 0] })], { material: 'chrome', body: 'fixed', position: [0, 2.6, 0] })],
    softParts: [{ type: 'cloth', id: 'curtain', position: [0, 1.55, 0], size: [2.5, 2.0], resolution: [34, 28], pins: 'top-edge', attachTo: 'rod', material: 'fabric-blue', bend: 0.01 }],
  },
  {
    id: 'trampoline', name: 'Trampoline', category: 'Soft & Fluid', description: 'Stretchy cloth pinned on all edges',
    parts: [part('frame', [
      cyl(0.04, 0.6, { position: [-1, 0.3, -1] }), cyl(0.04, 0.6, { position: [1, 0.3, -1] }),
      cyl(0.04, 0.6, { position: [-1, 0.3, 1] }), cyl(0.04, 0.6, { position: [1, 0.3, 1] }),
    ], { material: 'steel', body: 'fixed' })],
    softParts: [{
      type: 'cloth', id: 'mat', position: [0, 0.62, 0], rotation: [-90, 0, 0], size: [2, 2], resolution: [26, 26],
      pins: 'all-edges', material: { preset: 'fabric', color: '#1d1f24' }, stretch: 0.002, areaDensity: 1.2, bend: 0.001,
    }],
  },
  {
    id: 'sheet', name: 'Bed sheet', category: 'Soft & Fluid', description: 'Free cloth — drop it on things',
    softParts: [{ type: 'cloth', id: 'sheet', position: [0, 0, 0], rotation: [-90, 0, 0], size: [2.4, 2.4], resolution: [30, 30], pins: 'none', material: { preset: 'fabric', color: '#e9e4d8' } }],
  },
  {
    id: 'jelly-cube', name: 'Jelly cube', category: 'Soft & Fluid',
    softParts: [{ type: 'softbody', id: 'jelly', shape: 'box', size: [0.5, 0.5, 0.5], detail: 3, mass: 3, shapeMatching: 0.25, compliance: 0.0008, material: 'jelly-green' }],
  },
  {
    id: 'jelly-sphere', name: 'Jelly ball', category: 'Soft & Fluid',
    softParts: [{ type: 'softbody', id: 'jelly', shape: 'sphere', size: [0.3, 0.3, 0.3], detail: 3, mass: 2, shapeMatching: 0.12, material: 'jelly' }],
  },
  {
    id: 'balloon', name: 'Balloon', category: 'Soft & Fluid', description: 'Pressurised soft body',
    softParts: [{ type: 'softbody', id: 'balloon', shape: 'sphere', size: [0.32, 0.38, 0.32], detail: 3, mass: 0.08, pressure: 1.35, shapeMatching: 0.0, compliance: 0.0002, material: 'balloon' }],
  },
  {
    id: 'jelly-torus', name: 'Squishy ring', category: 'Soft & Fluid',
    softParts: [{ type: 'softbody', id: 'ring', shape: 'torus', size: [0.35, 0.12, 0.35], detail: 2, mass: 1.5, shapeMatching: 0.2, material: 'jelly' }],
  },
  {
    id: 'water-block', name: 'Water block', category: 'Soft & Fluid',
    softParts: [{ type: 'fluid', id: 'water', size: [0.6, 0.6, 0.6], material: 'water' }],
  },
  {
    id: 'water-hose', name: 'Water hose', category: 'Soft & Fluid', description: 'Emits a stream of water',
    parts: [part('nozzle', [cyl(0.06, 0.3, { rotation: [90, 0, 0] }), box([0.2, 0.06, 0.2], { position: [0, -0.45, -0.15] }), cyl(0.03, 0.45, { position: [0, -0.22, -0.15] })], { material: 'copper', body: 'fixed', position: [0, 0.5, 0] })],
    softParts: [{ type: 'fluid', id: 'stream', position: [0, 0.5, 0.2], size: [0.1, 0.1, 0.1], material: 'water', emitter: { rate: 260, velocity: [0, 1.2, 3.2], radius: 0.06, total: 2000 } }],
  },
];
