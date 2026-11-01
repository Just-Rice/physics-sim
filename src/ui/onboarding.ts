import { h, modal, prefs, svgIcon } from './dom';
import { icons } from './icons';

const SEEN_KEY = 'onboarded-v1';

export interface TourStep {
  target: string;
  title: string;
  text: string;
  /** Make sure the target is visible (e.g. open the library) before showing the step. */
  before?: () => void;
}

/** Welcome card shown once; returns immediately if it has been seen. */
export function maybeShowWelcome(steps: () => TourStep[], force = false): void {
  if (!force && prefs.get(SEEN_KEY)) return;
  prefs.set(SEEN_KEY, '1');
  const tile = (icon: string, title: string, text: string) =>
    h('div', { class: 'welcome-tile' }, h('div', { class: 'welcome-icon' }, svgIcon(icon)), h('div', {}, h('b', {}, title), h('div', { class: 'insp-sub' }, text)));
  const body = h('div', { class: 'welcome' },
    h('div', { class: 'welcome-mark' }),
    h('h2', {}, 'Welcome to Physics Sim'),
    h('p', { class: 'sub' }, 'A sandbox for throwing, stacking, smashing and building things — with real physics and photo-real light.'),
    h('div', { class: 'welcome-grid' },
      tile(icons.hand, 'Grab & throw', 'Drag any object with the mouse. Let go while moving to throw it.'),
      tile(icons.library, 'Add things', 'Drag a model from the library into the scene — or click it, then click where it goes.'),
      tile(icons.sparkle, 'Ray tracing', 'Flip the switch for realistic light. Pause to let the picture sharpen.'),
      tile(icons.spawn, 'Build your own', 'Snap shapes together with hinges and motors, or import from Blender.'),
    ),
    h('p', { class: 'insp-sub', style: 'margin-top:12px' }, 'Made a mess? Ctrl/⌘ + Z undoes it. Press H any time for help.'),
    h('div', { class: 'footer' },
      h('button', { class: 'btn', onclick: () => { m.close(); startTour(steps()); } }, 'Show me around'),
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Start playing')),
  );
  const m = modal(body);
}

/** Spotlight tour over the main controls. */
export function startTour(steps: TourStep[]): void {
  const ui = document.getElementById('ui')!;
  const spot = h('div', { class: 'tour-spot' });
  const title = h('div', { class: 'tour-title' });
  const text = h('div', { class: 'tour-text' });
  const count = h('span', { class: 'insp-sub' });
  const back = h('button', { class: 'btn small', onclick: () => go(i - 1) }, 'Back');
  const next = h('button', { class: 'btn small primary', onclick: () => go(i + 1) }, 'Next');
  const card = h('div', { class: 'tour-card panel', role: 'dialog' },
    title, text,
    h('div', { class: 'tour-foot' }, count, h('div', { style: 'flex:1' }), h('button', { class: 'btn small', onclick: () => end() }, 'Skip'), back, next));
  const layer = h('div', { class: 'tour-layer' }, spot, card);
  ui.append(layer);
  let i = 0;

  const place = () => {
    const step = steps[i];
    const el = document.querySelector<HTMLElement>(step.target);
    const r = el?.getBoundingClientRect();
    if (!r || r.width === 0) {
      spot.style.display = 'none';
      card.style.left = `${window.innerWidth / 2 - 170}px`;
      card.style.top = `${window.innerHeight / 2 - 80}px`;
      return;
    }
    const pad = 6;
    spot.style.display = 'block';
    spot.style.left = `${r.left - pad}px`;
    spot.style.top = `${r.top - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;
    const cw = Math.min(340, window.innerWidth - 24);
    card.style.width = `${cw}px`;
    const ch = card.offsetHeight || 140;
    // Prefer below, then above, then to the side.
    let top = r.bottom + 14;
    let left = r.left + r.width / 2 - cw / 2;
    if (top + ch > window.innerHeight - 12) top = r.top - ch - 14;
    if (top < 12) {
      top = Math.max(12, r.top + r.height / 2 - ch / 2);
      left = r.right + 14 + cw < window.innerWidth ? r.right + 14 : r.left - cw - 14;
    }
    card.style.left = `${Math.max(12, Math.min(window.innerWidth - cw - 12, left))}px`;
    card.style.top = `${Math.max(12, Math.min(window.innerHeight - ch - 12, top))}px`;
  };

  const go = (n: number) => {
    if (n >= steps.length) return end();
    if (n < 0) return;
    i = n;
    steps[i].before?.();
    title.textContent = steps[i].title;
    text.textContent = steps[i].text;
    count.textContent = `${i + 1} / ${steps.length}`;
    back.disabled = i === 0;
    back.style.visibility = i === 0 ? 'hidden' : 'visible';
    next.textContent = i === steps.length - 1 ? 'Done' : 'Next';
    // Panels may be animating open: place now and again once they settle.
    place();
    setTimeout(place, 250);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') go(i + 1);
    else if (e.key === 'ArrowLeft') go(i - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const end = () => {
    layer.remove();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  go(0);
}
