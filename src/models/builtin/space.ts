import type { ModelInput } from '../schema';
import { mesh, part, sphere } from './helpers';

export const space: ModelInput[] = [
  {
    id: 'star', name: 'Star (attractor)', category: 'Space',
    description: 'Fixed gravity source — use Attractor or N-body gravity',
    parts: [part('star', [sphere(0.8)], { material: 'sun', body: 'fixed', attractor: true, density: 9000 })],
  },
  { id: 'planet', name: 'Planet', category: 'Space', parts: [part('planet', [sphere(0.25)], { material: 'planet-blue', angularDamping: 0, linearDamping: 0 })] },
  { id: 'planet-red', name: 'Desert planet', category: 'Space', parts: [part('planet', [sphere(0.2)], { material: 'planet-red', angularDamping: 0, linearDamping: 0 })] },
  { id: 'gas-giant', name: 'Gas giant', category: 'Space', parts: [part('planet', [sphere(0.45)], { material: 'planet-gas', angularDamping: 0, linearDamping: 0 })] },
  { id: 'moon', name: 'Moon', category: 'Space', parts: [part('moon', [sphere(0.1)], { material: 'stone', angularDamping: 0, linearDamping: 0 })] },
  { id: 'asteroid', name: 'Asteroid', category: 'Space', parts: [part('rock', [mesh('proc:gem', { scale: [0.7, 0.5, 0.6] })], { material: 'stone', angularDamping: 0, linearDamping: 0 })] },
];
