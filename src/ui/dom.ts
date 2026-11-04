type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;
type Child = Node | string | null | undefined | false;

/** Minimal DOM builder: h('div', { class: 'x', onclick: fn }, child...). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function svgIcon(svg: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.style.display = 'contents';
  s.innerHTML = svg;
  return s;
}

export class Toasts {
  readonly el = h('div', { class: 'toast-host' });

  show(message: string, kind: 'info' | 'error' = 'info', ms = 2800): void {
    const t = h('div', { class: `toast panel ${kind}` }, message);
    this.el.append(t);
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    setTimeout(() => {
      t.style.transition = 'opacity 0.3s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 320);
    }, ms);
  }
}

/** In-app confirmation (replaces window.confirm, which is ugly in the Mac app). */
export function confirmDialog(title: string, message: string, opts: { confirm?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v: boolean) => {
      if (answered) return;
      answered = true;
      m.close();
      resolve(v);
    };
    const ok = h('button', { class: `btn ${opts.danger ? 'danger-fill' : 'primary'}`, onclick: () => done(true) }, opts.confirm ?? 'OK');
    const body = h('div', { class: 'confirm' },
      h('h2', {}, title),
      h('p', { class: 'sub' }, message),
      h('div', { class: 'footer' }, h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'), ok));
    const m = modal(body, { onClose: () => { if (!answered) { answered = true; resolve(false); } }, small: true });
    setTimeout(() => ok.focus(), 0);
  });
}

/** A finger (not a mouse) is the main pointer: phones and most tablets. */
export function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** localStorage that never throws (private windows, blocked storage, previews). */
export const prefs = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(`physics-sim:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(`physics-sim:${key}`, value);
    } catch {
      /* storage unavailable: preference just isn't remembered */
    }
  },
};

export function modal(content: HTMLElement, opts: { onClose?: () => void; dismissable?: boolean; small?: boolean } = {}): { close: () => void; el: HTMLElement } {
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: `modal panel${opts.small ? ' small' : ''}` }, content);
  back.append(box);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    window.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && opts.dismissable !== false) {
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back && opts.dismissable !== false) close();
  });
  document.getElementById('ui')!.append(back);
  return { close, el: box };
}
