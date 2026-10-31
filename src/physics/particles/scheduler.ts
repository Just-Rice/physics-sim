import { SHARED_ARRAYS, type Kernel, type ParallelExec, type ParticleWorld } from './ParticleWorld';

/** True when this page can share memory with workers. */
export function canUseThreads(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true && typeof Worker !== 'undefined';
}

export function autoThreadCount(): number {
  const hw = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(8, hw - 1));
}

/**
 * Worker pool for the particle kernels. The main thread takes the first slice
 * itself and spins (briefly) until the workers report back. If anything goes
 * wrong it reports `false` and the solver falls back to single-threaded.
 */
export class ParticleThreads implements ParallelExec {
  private workers: Worker[] = [];
  private ctrl = new Int32Array(new SharedArrayBuffer(16 * 4));
  private params = new Float64Array(new SharedArrayBuffer(128 * 8));
  private ready = 0;
  private epoch = -1;
  private broken = false;
  /** Total threads including the main thread. */
  readonly threads: number;

  constructor(threads: number) {
    this.threads = Math.max(2, threads);
  }

  get active(): boolean {
    return !this.broken && this.ready === this.workers.length && this.workers.length > 0;
  }

  /** Spin the workers up ahead of time so the first heavy step is already parallel. */
  prewarm(world: ParticleWorld): void {
    if (!this.broken && world.shared && world.epoch !== this.epoch) this.start(world);
  }

  private start(world: ParticleWorld): void {
    this.stop();
    this.epoch = world.epoch;
    this.ready = 0;
    Atomics.store(this.ctrl, 5, 0);
    Atomics.store(this.ctrl, 4, this.threads);
    const arrays: Record<string, SharedArrayBuffer> = {};
    const w = world as unknown as Record<string, { buffer: ArrayBufferLike }>;
    for (const name of SHARED_ARRAYS) arrays[name] = w[name].buffer as SharedArrayBuffer;
    for (let i = 0; i < this.threads - 1; i++) {
      const worker = new Worker(new URL('./particleWorker.ts', import.meta.url), { type: 'module', name: `particles-${i}` });
      worker.onmessage = (e) => {
        if (e.data?.type === 'ready') this.ready++;
      };
      worker.onerror = (e) => {
        console.warn('Particle worker failed; using a single thread', e.message);
        this.broken = true;
      };
      worker.postMessage({ type: 'init', index: i, ctrl: this.ctrl.buffer, params: this.params.buffer, arrays });
      this.workers.push(worker);
    }
  }

  stop(): void {
    if (!this.workers.length) return;
    Atomics.store(this.ctrl, 5, 1);
    Atomics.add(this.ctrl, 0, 1);
    Atomics.notify(this.ctrl, 0);
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.ready = 0;
  }

  run(world: ParticleWorld, kernel: Kernel, n: number): boolean {
    if (this.broken || !world.shared) return false;
    if (world.epoch !== this.epoch) this.start(world);
    if (this.ready < this.workers.length) return false; // still spinning up
    const p = world.kernelParams();
    for (let i = 0; i < p.length; i++) this.params[i] = p[i];
    const ctrl = this.ctrl;
    Atomics.store(ctrl, 3, 0);
    ctrl[1] = kernel;
    ctrl[2] = n;
    Atomics.add(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
    // Main thread does slice 0
    const chunk = Math.ceil(n / this.threads);
    world.runKernel(kernel, 0, Math.min(n, chunk));
    const need = this.workers.length;
    const t0 = performance.now();
    let spins = 0;
    while (Atomics.load(ctrl, 3) < need) {
      if ((++spins & 1023) === 0 && performance.now() - t0 > 2000) {
        console.warn('Particle workers stopped responding; using a single thread');
        this.broken = true;
        this.stop();
        // Finish the remaining slices here so this step is still correct.
        world.runKernel(kernel, Math.min(n, chunk), n);
        return true;
      }
    }
    return true;
  }
}
