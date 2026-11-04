import './ui/styles.css';
import { App } from './app/App';
import { ParticlePlugin } from './physics/particles/ParticlePlugin';
import { Builder } from './editor/Builder';
import { importFiles, registerStoredAsset } from './models/import/importModel';
import { exportModelGLB } from './models/export/exportModel';

// iOS Safari ignores user-scalable=no; stop page pinch-zoom so two-finger
// gestures always reach the 3D view instead of zooming the whole app.
for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });

/** Plain words for the usual reasons a phone or old browser can't start. */
function startupMessage(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (/webgl/i.test(msg)) {
    return 'This browser couldn’t start 3D graphics (WebGL). Try updating it, turning off battery saver, or opening the page in Safari or Chrome.';
  }
  if (/wasm|webassembly/i.test(msg)) {
    return 'This browser couldn’t load the physics engine (WebAssembly). Try updating it, or opening the page in Safari or Chrome.';
  }
  return `Failed to start: ${msg}`;
}

async function main() {
  const app = new App({
    createParticles(app) {
      const p = new ParticlePlugin(app.sim, app.settings, () => app.settings.data.raytracing.enabled && !!app.pt);
      app.sim.addPlugin(p);
      app.view.scene.add(p.group);
      p.onBudget = () => app.toast('Particle budget reached — raise “Max particles” in Settings or clear some soft objects', 'error');
      return p;
    },
    createBuilder: (app) => new Builder(app),
    importFiles: (app, files, opts) => importFiles(app, files, opts),
    assetLoader: async (asset) => {
      await registerStoredAsset(asset);
    },
    exportModel: async (app, model) => {
      const glb = await exportModelGLB(model);
      await app.platform.saveFile(`${model.id}.glb`, new Blob([glb], { type: 'model/gltf-binary' }));
    },
  });
  // Small hook for automated smoke tests and the browser console.
  (window as unknown as { physicsDebug: object }).physicsDebug = { exportModelGLB, importFiles };
  try {
    await app.init();
  } catch (err) {
    console.error(err);
    const s = document.getElementById('boot-status');
    if (s) s.textContent = startupMessage(err);
  }
}

main();
