import './ui/styles.css';
import { App } from './app/App';
import { ParticlePlugin } from './physics/particles/ParticlePlugin';

async function main() {
  const app = new App({
    createParticles(app) {
      const p = new ParticlePlugin(app.sim, app.settings, () => app.settings.data.raytracing.enabled && !!app.pt);
      app.sim.addPlugin(p);
      app.view.scene.add(p.group);
      p.onBudget = () => app.toast('Particle budget reached — raise “Max particles” in Settings or clear some soft objects', 'error');
      return p;
    },
  });
  try {
    await app.init();
  } catch (err) {
    console.error(err);
    const s = document.getElementById('boot-status');
    if (s) s.textContent = `Failed to start: ${(err as Error).message}`;
  }
}

main();
