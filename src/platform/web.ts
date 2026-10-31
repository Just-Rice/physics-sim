import type { PickedFile, Platform } from './types';

function pickWithInput(accept: string[], multiple: boolean): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept.join(',');
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const done = async () => {
      if (settled) return;
      settled = true;
      const files = [...(input.files ?? [])];
      input.remove();
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() }))));
    };
    input.addEventListener('change', done);
    input.addEventListener('cancel', () => {
      settled = true;
      input.remove();
      resolve([]);
    });
    input.click();
  });
}

export function createWebPlatform(): Platform {
  return {
    kind: 'web',
    hardwareThreads: navigator.hardwareConcurrency || 4,
    openFiles: ({ accept, multiple }) => pickWithInput(accept, multiple ?? false),
    async saveFile(name, data) {
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return true;
    },
  };
}
