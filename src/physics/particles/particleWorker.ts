/// <reference lib="webworker" />
import { ParticleWorld, SHARED_ARRAYS, type Kernel } from './ParticleWorld';

/**
 * Particle solver worker. It shares the particle arrays with the main thread
 * (SharedArrayBuffer) and runs one slice of a kernel whenever the control
 * word's generation counter changes. No messages are exchanged per step:
 * synchronisation is Atomics.wait / notify only.
 *
 * Control layout (Int32Array): 0 generation, 1 kernel, 2 particle count,
 * 3 finished counter, 4 thread count, 5 quit flag.
 */

interface InitMessage {
  type: 'init';
  index: number;
  ctrl: SharedArrayBuffer;
  params: SharedArrayBuffer;
  arrays: Record<string, SharedArrayBuffer>;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<InitMessage>) => {
  if (e.data.type !== 'init') return;
  const { index, arrays } = e.data;
  const ctrl = new Int32Array(e.data.ctrl);
  const params = new Float64Array(e.data.params);
  const world = new ParticleWorld(0);
  const w = world as unknown as Record<string, unknown>;
  for (const name of SHARED_ARRAYS) {
    const template = w[name] as { constructor: new (b: ArrayBufferLike) => unknown };
    w[name] = new template.constructor(arrays[name]);
  }
  ctx.postMessage({ type: 'ready', index });
  let gen = Atomics.load(ctrl, 0);
  for (;;) {
    Atomics.wait(ctrl, 0, gen);
    gen = Atomics.load(ctrl, 0);
    if (Atomics.load(ctrl, 5) === 1) return;
    world.setKernelParams(params);
    const n = ctrl[2];
    const threads = ctrl[4];
    const chunk = Math.ceil(n / threads);
    const from = Math.min(n, chunk * (index + 1));
    const to = Math.min(n, from + chunk);
    if (to > from) world.runKernel(ctrl[1] as Kernel, from, to);
    Atomics.add(ctrl, 3, 1);
    Atomics.notify(ctrl, 3);
  }
};
