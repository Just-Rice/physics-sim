/**
 * What kind of device we're on, so phones get lighter defaults. Desktop
 * browsers (and the Mac app) report `mobile: false` and keep full quality.
 */
export interface DeviceProfile {
  /** A finger is the main pointer. */
  touch: boolean;
  /** iPhone, iPad (iPadOS reports itself as a Mac with touch) or iPod. */
  ios: boolean;
  android: boolean;
  /** Small touch screen. */
  phone: boolean;
  tablet: boolean;
  /** Phone or tablet. */
  mobile: boolean;
}

export function detectDevice(): DeviceProfile {
  if (typeof navigator === 'undefined' || typeof matchMedia !== 'function') {
    return { touch: false, ios: false, android: false, phone: false, tablet: false, mobile: false };
  }
  const ua = navigator.userAgent;
  const touchPoints = navigator.maxTouchPoints || 0;
  const touch = matchMedia('(pointer: coarse)').matches;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const android = /Android/.test(ua);
  const handheld = touch || ios || android;
  const shortSide = Math.min(screen.width, screen.height);
  const phone = handheld && shortSide <= 540;
  const tablet = !phone && (ios || android || (touch && touchPoints > 1));
  return { touch, ios, android, phone, tablet, mobile: phone || tablet };
}

export const device: DeviceProfile = detectDevice();
