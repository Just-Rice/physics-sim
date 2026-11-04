import type { PickedFile, Platform } from './types';
import { device } from '../app/device';

function pickWithInput(accept: string[], multiple: boolean): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // iOS greys out files it has no type for (.glb, .gltf, .obj, .stl) when
    // `accept` lists extensions, so let it show everything; the importer
    // rejects anything it can't read.
    if (!device.ios) input.accept = accept.join(',');
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
      // Phones: pictures go through the share sheet, which offers "Save Image".
      if (device.mobile && data.type.startsWith('image/') && typeof navigator.share === 'function') {
        const file = new File([data], name, { type: data.type });
        if (navigator.canShare?.({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: name });
            return true;
          } catch (err) {
            if ((err as DOMException).name === 'AbortError') return false; // they closed the sheet
            // NotAllowedError (the tap was too long ago) and friends: download instead.
          }
        }
      }
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
