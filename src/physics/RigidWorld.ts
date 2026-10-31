import RAPIER from '@dimforge/rapier3d-compat';

let initPromise: Promise<void> | null = null;

/** Rapier ships as WASM inlined in JS; it must be initialised once before use. */
export function initRapier(): Promise<void> {
  if (!initPromise) {
    // The compat build accepts no args; newer versions warn about the old init signature.
    initPromise = (RAPIER.init as unknown as () => Promise<void>)();
  }
  return initPromise;
}

export { RAPIER };

export const FIXED_DT = 1 / 120;

/**
 * Thin wrapper around a Rapier world with a fixed timestep. Force fields and
 * tools add forces each step through `beforeStep` callbacks.
 */
export class RigidWorld {
  world: RAPIER.World;
  readonly dt = FIXED_DT;
  private beforeStepFns: ((dt: number) => void)[] = [];
  time = 0;

  constructor(gravityY = -9.81) {
    this.world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
    this.world.timestep = this.dt;
    this.world.numSolverIterations = 4;
  }

  setGravity(x: number, y: number, z: number): void {
    this.world.gravity = { x, y, z };
  }

  setSolverIterations(n: number): void {
    this.world.numSolverIterations = Math.max(1, Math.round(n));
  }

  onBeforeStep(fn: (dt: number) => void): () => void {
    this.beforeStepFns.push(fn);
    return () => {
      this.beforeStepFns = this.beforeStepFns.filter((f) => f !== fn);
    };
  }

  step(): void {
    // User forces are cleared every step and re-applied by the field/tool callbacks.
    this.world.forEachRigidBody((b) => {
      if (b.isDynamic()) {
        b.resetForces(false);
        b.resetTorques(false);
      }
    });
    for (const fn of this.beforeStepFns) fn(this.dt);
    this.world.step();
    this.time += this.dt;
  }

  dispose(): void {
    this.world.free();
  }
}
