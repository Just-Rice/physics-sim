import { h, modal } from './dom';
import { SCENARIOS } from '../scenes/scenarios';

/** Gallery of ready-made scenes. */
export function showScenePicker(currentId: string, onPick: (id: string) => void, extras: { onLoadFile(): void; onSaveFile(): void }): void {
  const card = (s: (typeof SCENARIOS)[number]) =>
    h('button', {
      class: `scene-card${s.id === currentId ? ' current' : ''}`,
      'data-id': s.id,
      onclick: () => {
        m.close();
        onPick(s.id);
      },
    },
    h('div', { class: 'scene-name' }, s.name, s.id === currentId ? h('span', { class: 'scene-current' }, 'current') : null),
    h('div', { class: 'scene-desc' }, s.description),
    h('div', { class: 'scene-tags' }, ...s.tags.map((t) => h('span', { class: 'tag' }, t))));
  const body = h('div', { class: 'scene-picker' },
    h('h2', {}, 'Choose a scene'),
    h('p', { class: 'sub' }, 'Each scene sets up objects, gravity and lighting. You can change anything afterwards.'),
    h('div', { class: 'scene-grid' }, ...SCENARIOS.map(card)),
    h('div', { class: 'footer' },
      h('button', { class: 'btn', onclick: () => { m.close(); extras.onLoadFile(); } }, 'Open a saved scene…'),
      h('button', { class: 'btn', onclick: () => { m.close(); extras.onSaveFile(); } }, 'Save this scene…'),
      h('div', { style: 'flex:1' }),
      h('button', { class: 'btn', onclick: () => m.close() }, 'Close')),
  );
  const m = modal(body);
  setTimeout(() => body.querySelector<HTMLButtonElement>('.scene-card.current')?.focus(), 0);
}
