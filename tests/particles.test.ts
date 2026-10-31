import { beforeAll, describe, expect, it } from 'vitest';
import { initRapier } from '../src/physics/RigidWorld';
import { Simulation } from '../src/sim/Simulation';
import { SettingsStore } from '../src/app/settings';
import { ParticlePlugin } from '../src/physics/particles/ParticlePlugin';
import { parseModel } from '../src/models/schema';
import { registerProceduralAssets } from '../src/models/assets';
import { FLAG_FLUID } from '../src/physics/particles/ParticleWorld';

beforeAll(async () => {
  await initRapier();
  registerProceduralAssets();
});

function setup() {
  const settings = new SettingsStore();
  settings.data.physics.airDrag = false;
  const sim = new Simulation(settings);
  const plugin = new ParticlePlugin(sim, settings, () => false);
  sim.addPlugin(plugin);
  return { settings, sim, plugin };
}

function run(sim: Simulation, seconds: number) {
  const n = Math.round(seconds / sim.rigid.dt);
  for (let i = 0; i < n; i++) sim.stepOnce();
}

describe('particles', () => {
  it('a pinned cloth hangs without exploding and keeps its edge lengths', () => {
    const { sim, plugin } = setup();
    const model = parseModel({ id: 'c', name: 'c', softParts: [{ type: 'cloth', id: 'c', position: [0, 2, 0], size: [1, 1], resolution: [12, 12], pins: 'top-edge' }] });
    sim.spawn(model, { model: 'c', position: [0, 0, 0], rotation: [0, 0, 0] });
    run(sim, 2);
    const w = plugin.world;
    let maxSpeed = 0, minY = Infinity, maxStretch = 0;
    for (let i = 0; i < w.count; i++) {
      maxSpeed = Math.max(maxSpeed, Math.hypot(w.vel[i * 3], w.vel[i * 3 + 1], w.vel[i * 3 + 2]));
      minY = Math.min(minY, w.pos[i * 3 + 1]);
    }
    for (let c = 0; c < w.cCount; c++) {
      const a = w.cA[c], b = w.cB[c];
      const d = Math.hypot(w.pos[a * 3] - w.pos[b * 3], w.pos[a * 3 + 1] - w.pos[b * 3 + 1], w.pos[a * 3 + 2] - w.pos[b * 3 + 2]);
      maxStretch = Math.max(maxStretch, d / w.cRest[c]);
    }
    expect(maxSpeed).toBeLessThan(2);
    expect(minY).toBeGreaterThan(0.9); // hangs below the pins (top at 2.5) but not fallen
    expect(maxStretch).toBeLessThan(1.15);
  });

  it('a soft body keeps its volume after landing', () => {
    const { sim, plugin } = setup();
    const model = parseModel({ id: 's', name: 's', softParts: [{ type: 'softbody', id: 's', shape: 'sphere', size: [0.3, 0.3, 0.3], detail: 2, shapeMatching: 0.1 }] });
    sim.spawn(model, { model: 's', position: [0, 1, 0], rotation: [0, 0, 0] });
    run(sim, 2.5);
    const w = plugin.world;
    const sb = w.softBodies[0];
    let V = 0;
    const p = w.pos, t = sb.triangles;
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3;
      V += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
    expect(Math.abs(V / sb.restVolume - 1)).toBeLessThan(0.05);
    let minY = Infinity;
    for (let i = 0; i < w.count; i++) minY = Math.min(minY, p[i * 3 + 1]);
    expect(minY).toBeGreaterThan(-0.01);
  });

  it('water in a tank settles near rest density and stays inside', () => {
    const { sim, plugin } = setup();
    sim.spawn(parseModel({
      id: 'tank', name: 'tank',
      parts: [{ id: 't', body: 'fixed', shapes: [
        { type: 'box', size: [1.2, 0.05, 0.6], position: [0, 0.025, 0] },
        { type: 'box', size: [0.05, 1, 0.6], position: [-0.625, 0.5, 0] },
        { type: 'box', size: [0.05, 1, 0.6], position: [0.625, 0.5, 0] },
        { type: 'box', size: [1.3, 1, 0.05], position: [0, 0.5, -0.325] },
        { type: 'box', size: [1.3, 1, 0.05], position: [0, 0.5, 0.325] },
      ] }],
    }), { model: 'tank', position: [0, 0, 0], rotation: [0, 0, 0] });
    sim.spawn(parseModel({ id: 'w', name: 'w', softParts: [{ type: 'fluid', id: 'w', size: [0.4, 0.5, 0.4] }] }), { model: 'w', position: [-0.3, 0.4, 0], rotation: [0, 0, 0] });
    const w = plugin.world;
    const n = w.count;
    expect(n).toBeGreaterThan(100);
    run(sim, 3);
    let inside = 0, maxY = -Infinity;
    for (let i = 0; i < w.count; i++) {
      if (!(w.flags[i] & FLAG_FLUID)) continue;
      const x = w.pos[i * 3], y = w.pos[i * 3 + 1], z = w.pos[i * 3 + 2];
      if (Math.abs(x) < 0.62 && Math.abs(z) < 0.32 && y > 0.03 && y < 1.1) inside++;
      maxY = Math.max(maxY, y);
    }
    expect(inside / n).toBeGreaterThan(0.97);
    // Water spread over the tank: original column 0.5 tall over 0.4×0.4 → ~0.13 m over 1.2×0.6
    expect(maxY).toBeLessThan(0.45);
    let maxSpeed = 0;
    for (let i = 0; i < w.count; i++) maxSpeed = Math.max(maxSpeed, Math.hypot(w.vel[i * 3], w.vel[i * 3 + 1], w.vel[i * 3 + 2]));
    expect(maxSpeed).toBeLessThan(1.5);
  });

  it('a wooden crate floats in water', () => {
    const { sim, plugin } = setup();
    sim.spawn(parseModel({
      id: 'tank', name: 'tank',
      parts: [{ id: 't', body: 'fixed', shapes: [
        { type: 'box', size: [1, 0.05, 1], position: [0, 0.025, 0] },
        { type: 'box', size: [0.05, 1, 1], position: [-0.525, 0.5, 0] },
        { type: 'box', size: [0.05, 1, 1], position: [0.525, 0.5, 0] },
        { type: 'box', size: [1.1, 1, 0.05], position: [0, 0.5, -0.525] },
        { type: 'box', size: [1.1, 1, 0.05], position: [0, 0.5, 0.525] },
      ] }],
    }), { model: 'tank', position: [0, 0, 0], rotation: [0, 0, 0] });
    sim.spawn(parseModel({ id: 'w', name: 'w', softParts: [{ type: 'fluid', id: 'w', size: [0.96, 0.4, 0.96] }] }), { model: 'w', position: [0, 0.27, 0], rotation: [0, 0, 0] });
    const crate = sim.spawn(parseModel({ id: 'c', name: 'c', parts: [{ id: 'c', material: 'foam', shapes: [{ type: 'box', size: [0.3, 0.3, 0.3] }] }] }), { model: 'c', position: [0, 0.7, 0], rotation: [0, 0, 0] });
    run(sim, 3);
    const y = crate.parts[0].body.translation().y;
    // Water surface is around 0.45; a foam block should ride on top rather than sink to the floor (0.2).
    expect(y).toBeGreaterThan(0.33);
    expect(plugin.world.count).toBeGreaterThan(100);
  });
});
