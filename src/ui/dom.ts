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

export function modal(content: HTMLElement, opts: { onClose?: () => void; dismissable?: boolean } = {}): { close: () => void; el: HTMLElement } {
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: 'modal panel' }, content);
  back.append(box);
  const close = () => {
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
