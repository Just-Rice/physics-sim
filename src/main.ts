import './ui/styles.css';
import { App } from './app/App';

async function main() {
  const app = new App({});
  try {
    await app.init();
  } catch (err) {
    console.error(err);
    const s = document.getElementById('boot-status');
    if (s) s.textContent = `Failed to start: ${(err as Error).message}`;
  }
}

main();
