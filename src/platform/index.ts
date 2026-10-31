import { createDesktopPlatform } from './desktop';
import { createWebPlatform } from './web';
import type { Platform } from './types';

export type { Platform, PickedFile, MenuCommand } from './types';

export function detectPlatform(): Platform {
  if (typeof window !== 'undefined' && window.physicsSim) return createDesktopPlatform(window.physicsSim);
  return createWebPlatform();
}
