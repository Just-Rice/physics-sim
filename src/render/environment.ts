import * as THREE from 'three';
import type { EnvironmentPreset } from '../app/settings';

/**
 * Procedural HDR environments generated on the CPU as equirectangular
 * half-float textures. The same texture lights the raster view (three.js
 * pre-filters it automatically) and the path tracer (which importance-samples
 * it, so the sun disc casts soft, physically based shadows).
 */

export interface EnvironmentResult {
  texture: THREE.DataTexture;
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  /** Irradiance of the sun disc in the same units as the texture. */
  sunIntensity: number;
  ambient: number;
}

const W = 1024;
const H = 512;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sunDirectionFrom(elevationDeg: number, azimuthDeg: number): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();
}

export function generateEnvironment(preset: EnvironmentPreset, elevationDeg: number, azimuthDeg: number): EnvironmentResult {
  const data = new Float32Array(W * H * 4);
  const sun = sunDirectionFrom(preset === 'golden' ? Math.min(elevationDeg, 8) : elevationDeg, azimuthDeg);
  const sunEl = Math.max(-0.2, sun.y);

  // Colour palette by preset
  let zenith = new THREE.Color(0.1, 0.28, 0.78);
  let horizon = new THREE.Color(0.6, 0.74, 0.95);
  let groundCol = new THREE.Color(0.22, 0.21, 0.2);
  let sunColor = new THREE.Color(1.0, 0.96, 0.9);
  let sunIrradiance = 9;
  let skyScale = 1.0;
  let sunRadius = THREE.MathUtils.degToRad(0.9);

  if (preset === 'golden') {
    zenith = new THREE.Color(0.22, 0.3, 0.6);
    horizon = new THREE.Color(1.0, 0.62, 0.35);
    sunColor = new THREE.Color(1.0, 0.62, 0.32);
    sunIrradiance = 7;
    skyScale = 0.55;
    sunRadius = THREE.MathUtils.degToRad(1.4);
  } else if (preset === 'night') {
    zenith = new THREE.Color(0.006, 0.01, 0.03);
    horizon = new THREE.Color(0.03, 0.045, 0.08);
    groundCol = new THREE.Color(0.01, 0.01, 0.012);
    sunColor = new THREE.Color(0.75, 0.82, 1.0); // moon
    sunIrradiance = 0.35;
    skyScale = 1;
    sunRadius = THREE.MathUtils.degToRad(1.2);
  } else if (preset === 'studio') {
    zenith = new THREE.Color(0.05, 0.05, 0.055);
    horizon = new THREE.Color(0.11, 0.11, 0.115);
    groundCol = new THREE.Color(0.06, 0.06, 0.06);
    sunIrradiance = 0;
  } else {
    // Day: sky gets warmer and dimmer as the sun drops
    const t = smoothstep(0.0, 0.5, sunEl);
    horizon.lerp(new THREE.Color(1.0, 0.75, 0.55), 1 - t);
    skyScale = 0.35 + 0.65 * t;
    sunColor.lerp(new THREE.Color(1.0, 0.7, 0.45), 1 - t);
  }

  const sunCos = Math.cos(sunRadius);
  const sunSolidAngle = 2 * Math.PI * (1 - sunCos);
  const sunRadiance = sunIrradiance / sunSolidAngle;
  const rand = mulberry32(1234);
  const dir = new THREE.Vector3();
  const c = new THREE.Color();

  // Studio softboxes: [azimuthDeg, elevationDeg, halfWidthDeg, halfHeightDeg, intensity]
  const softboxes: [number, number, number, number, number][] = [
    [40, 35, 22, 14, 7],
    [-120, 25, 18, 10, 3.5],
    [160, 60, 28, 12, 2.0],
    [-30, 8, 50, 3, 1.4],
  ];

  for (let j = 0; j < H; j++) {
    const el = ((j + 0.5) / H) * Math.PI - Math.PI / 2;
    const cosEl = Math.cos(el);
    const sinEl = Math.sin(el);
    for (let i = 0; i < W; i++) {
      const phi = ((i + 0.5) / W - 0.5) * Math.PI * 2;
      dir.set(Math.cos(phi) * cosEl, sinEl, Math.sin(phi) * cosEl);
      const mu = dir.dot(sun);

      if (sinEl >= 0) {
        const h = Math.pow(sinEl, 0.45);
        c.copy(horizon).lerp(zenith, h);
        c.multiplyScalar(skyScale);
        if (preset !== 'studio') {
          // Mie glow around the sun and a little Rayleigh brightening
          const glow = Math.pow(Math.max(mu, 0), 12) * 0.9 + Math.pow(Math.max(mu, 0), 96) * 4;
          c.r += sunColor.r * glow * (preset === 'night' ? 0.03 : 0.35);
          c.g += sunColor.g * glow * (preset === 'night' ? 0.03 : 0.35);
          c.b += sunColor.b * glow * (preset === 'night' ? 0.03 : 0.35);
        }
      } else {
        // Below horizon: darkened ground bounce, blended to avoid a hard seam
        const k = smoothstep(0, -0.08, sinEl);
        c.copy(horizon).multiplyScalar(skyScale * 0.6).lerp(groundCol, k);
      }

      if (preset === 'night' && sinEl > 0.02 && rand() > 0.9975) {
        const s = 0.5 + rand() * 4;
        c.r += s; c.g += s; c.b += s * 1.1;
      }

      if (preset === 'studio') {
        const az = THREE.MathUtils.radToDeg(Math.atan2(dir.z, dir.x));
        const elDeg = THREE.MathUtils.radToDeg(el);
        for (const [baz, bel, hw, hh, inten] of softboxes) {
          let daz = Math.abs(az - baz);
          if (daz > 180) daz = 360 - daz;
          const fx = smoothstep(hw, hw - 2, daz);
          const fy = smoothstep(hh, hh - 2, Math.abs(elDeg - bel));
          const f = fx * fy;
          if (f > 0) {
            c.r += inten * f; c.g += inten * f; c.b += inten * f * 0.97;
          }
        }
      } else if (mu > sunCos && sunIrradiance > 0) {
        // Sun disc with slight limb darkening
        const r = Math.sqrt(Math.max(0, 1 - (mu - sunCos) / (1 - sunCos)));
        const limb = 1 - 0.4 * r * r;
        const L = sunRadiance * limb * smoothstep(0, 0.15, (mu - sunCos) / (1 - sunCos) + 0.05);
        c.r += sunColor.r * L; c.g += sunColor.g * L; c.b += sunColor.b * L;
      }

      const o = (j * W + i) * 4;
      data[o] = c.r;
      data[o + 1] = c.g;
      data[o + 2] = c.b;
      data[o + 3] = 1;
    }
  }

  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(Math.min(data[i], 65000));
  const texture = new THREE.DataTexture(half, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const ambient = preset === 'night' ? 0.15 : preset === 'studio' ? 0.4 : 0.3;
  return { texture, sunDirection: sun, sunColor, sunIntensity: sunIrradiance, ambient };
}
