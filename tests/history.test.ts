import { describe, expect, it } from 'vitest';
import { History } from '../src/app/history';
import type { SavedScene } from '../src/scenes/sceneIO';

/** A stand-in scene: only the entity count matters here. */
const scene = (n: number) => ({ entities: new Array(n) }) as unknown as SavedScene;
const count = (s: SavedScene | undefined) => s?.entities.length;

describe('undo history', () => {
  it('undoes and redoes back and forth through every step', () => {
    const h = new History();
    let state = 0;
    const take = () => scene(state);
    for (let i = 0; i < 3; i++) {
      h.record('add', take, 0, i * 1000);
      state++;
    }
    expect(state).toBe(3);
    // Undo three times: 3 → 2 → 1 → 0
    for (const expected of [2, 1, 0]) {
      const e = h.undo(take);
      state = count(e?.scene)!;
      expect(state).toBe(expected);
    }
    expect(h.canUndo).toBe(false);
    expect(h.undo(take)).toBeNull();
    // And forward again: 0 → 1 → 2 → 3
    for (const expected of [1, 2, 3]) {
      state = count(h.redo(take)?.scene)!;
      expect(state).toBe(expected);
    }
    expect(h.canRedo).toBe(false);
  });

  it('merges quick repeats of the same action into one step', () => {
    const h = new History();
    let snaps = 0;
    const take = () => (snaps++, scene(0));
    expect(h.record('cannon', take, 600, 0)).toBe(true);
    expect(h.record('cannon', take, 600, 300)).toBe(false);
    expect(h.record('cannon', take, 600, 800)).toBe(false); // still within 600 ms of the last shot
    expect(h.record('cannon', take, 600, 2000)).toBe(true);
    expect(h.record('explode', take, 600, 2100)).toBe(true); // a different action is its own step
    expect(snaps).toBe(3);
    expect(h.undoLabel).toBe('explode');
  });

  it('a new action clears redo, and old steps fall off past the limit', () => {
    const h = new History(5);
    for (let i = 0; i < 8; i++) h.record('add', () => scene(i), 0, i * 1000);
    let undos = 0;
    while (h.undo(() => scene(99))) undos++;
    expect(undos).toBe(5);
    h.record('delete', () => scene(1), 0, 99_000);
    expect(h.canRedo).toBe(false);
    expect(h.undoLabel).toBe('delete');
  });
});
