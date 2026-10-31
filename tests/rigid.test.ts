import { beforeAll, describe, expect, it } from 'vitest';
import { initRapier } from '../src/physics/RigidWorld';
import { Simulation } from '../src/sim/Simulation';
import { SettingsStore } from '../src/app/settings';
import { parseModel } from '../src/models/schema';

beforeAll(async () => {
  await initRapier();
});

function ball(restitution: number) {
  return parseModel({
    id: 'ball', name: 'Ball',
    parts: [{ id: 'b', material: 'rubber', restitution, shapes: [{ type: 'sphere', radius: 0.2 }] }],
  });
}

function run(sim: Simulation, seconds: number) {
  const n = Math.round(seconds / sim.rigid.dt);
  for (let i = 0; i < n; i++) sim.stepOnce();
}

describe('rigid bodies', () => {
  it('a dropped sphere lands on the ground and comes to rest', () => {
    const settings = new SettingsStore();
    settings.data.physics.airDrag = false;
    const sim = new Simulation(settings);
    const e = sim.spawn(ball(0), { model: 'ball', position: [0, 3, 0], rotation: [0, 0, 0] });
    run(sim, 4);
    const p = e.parts[0].body.translation();
    expect(p.y).toBeGreaterThan(0.17);
    expect(p.y).toBeLessThan(0.23);
    const v = e.parts[0].body.linvel();
    expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(0.05);
  });

  it('restitution controls bounce height', () => {
    const heights: number[] = [];
    for (const r of [0.1, 0.9]) {
      const settings = new SettingsStore();
      settings.data.physics.airDrag = false;
      const sim = new Simulation(settings);
      const e = sim.spawn(ball(r), { model: 'ball', position: [0, 2.2, 0], rotation: [0, 0, 0] });
      let landed = false;
      let peak = 0;
      for (let i = 0; i < 400; i++) {
        sim.stepOnce();
        const b = e.parts[0].body;
        const y = b.translation().y;
        if (!landed && y < 0.25) landed = true;
        if (landed) peak = Math.max(peak, y);
      }
      heights.push(peak);
    }
    expect(heights[1]).toBeGreaterThan(heights[0] + 0.3);
  });

  it('a hinge joint holds its anchor and a motor reaches its target speed', () => {
    const settings = new SettingsStore();
    const sim = new Simulation(settings);
    const model = parseModel({
      id: 'wheel', name: 'Wheel',
      parts: [{ id: 'w', material: 'steel', shapes: [{ type: 'cylinder', radius: 0.5, height: 0.1, rotation: [90, 0, 0] }] }],
      joints: [{ type: 'hinge', a: 'w', b: null, anchor: [0, 0, 0], axis: [0, 0, 1], motor: { velocity: 3, force: 100 } }],
    });
    const e = sim.spawn(model, { model: 'wheel', position: [0, 2, 0], rotation: [0, 0, 0] });
    run(sim, 3);
    const b = e.parts[0].body;
    const t = b.translation();
    expect(Math.hypot(t.x, t.y - 2, t.z)).toBeLessThan(0.02);
    expect(b.angvel().z).toBeGreaterThan(2.7);
    expect(b.angvel().z).toBeLessThan(3.3);
  });
});
