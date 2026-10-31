import { beforeAll, describe, expect, it } from 'vitest';
import { initRapier } from '../src/physics/RigidWorld';
import { Simulation } from '../src/sim/Simulation';
import { SettingsStore } from '../src/app/settings';
import { figure8Placements, FIGURE8_PERIOD } from '../src/scenes/scenarios';
import { G_BASE, partMass } from '../src/physics/gravity';
import type { ModelDef } from '../src/models/schema';

beforeAll(async () => {
  await initRapier();
});

function energy(sim: Simulation): number {
  const parts = sim.parts.filter((p) => p.body.isDynamic());
  let ke = 0, pe = 0;
  for (const p of parts) {
    const v = p.body.linvel();
    ke += 0.5 * p.body.mass() * (v.x * v.x + v.y * v.y + v.z * v.z);
  }
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i].body.worldCom(), b = parts[j].body.worldCom();
      const r = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      pe -= (G_BASE * partMass(parts[i]) * partMass(parts[j])) / r;
    }
  }
  return ke + pe;
}

describe('n-body gravity', () => {
  it('the figure-8 orbit returns near its start after one period', () => {
    const settings = new SettingsStore();
    settings.data.physics.gravityMode = 'nbody';
    settings.data.physics.G = 1;
    settings.data.physics.airDrag = false;
    const sim = new Simulation(settings);
    sim.setGroundEnabled(false);
    const placements = figure8Placements();
    const ents = placements.map((p) => sim.spawn(p.model as ModelDef, { model: 'x', position: p.position!, rotation: [0, 0, 0], velocity: p.velocity }));
    for (const e of ents) e.parts[0].body.setAngularDamping(0);
    for (const e of ents) e.parts[0].body.setLinearDamping(0);
    const start = ents.map((e) => ({ ...e.parts[0].body.translation() }));
    const e0 = energy(sim);
    // The integrator is first-order, so allow a few percent of period drift and
    // look for the closest return within a window around one period.
    const steps = Math.round((FIGURE8_PERIOD * 1.15) / sim.rigid.dt);
    const from = Math.round((FIGURE8_PERIOD * 0.9) / sim.rigid.dt);
    let best = Infinity;
    for (let i = 0; i < steps; i++) {
      sim.stepOnce();
      if (i < from) continue;
      let worst = 0;
      ents.forEach((e, k) => {
        const t = e.parts[0].body.translation();
        worst = Math.max(worst, Math.hypot(t.x - start[k].x, t.y - start[k].y, t.z - start[k].z));
      });
      best = Math.min(best, worst);
    }
    expect(best).toBeLessThan(0.3);
    const e1 = energy(sim);
    expect(Math.abs((e1 - e0) / e0)).toBeLessThan(0.02);
  });
});
