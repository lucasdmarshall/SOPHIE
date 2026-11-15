import type { HoloTheme } from './types';

export interface Preset {
  id: string;
  name: string;
  primary: string;
  secondary: string;
  accent: string;
}

export const PRESETS: Preset[] = [
  { id: 'arc', name: 'Arc Reactor', primary: '#38e8ff', secondary: '#7c6bff', accent: '#ff4fd8' },
  { id: 'solar', name: 'Solar Flare', primary: '#ffb547', secondary: '#ff6a3d', accent: '#fff08a' },
  { id: 'matrix', name: 'Bio Matrix', primary: '#3dff9a', secondary: '#1fc8d1', accent: '#d4ff4d' },
  { id: 'crimson', name: 'Red Alert', primary: '#ff3d5a', secondary: '#ff8a3d', accent: '#ffd0e0' },
  { id: 'nebula', name: 'Nebula', primary: '#b46bff', secondary: '#5b7cff', accent: '#ff6bd6' },
  { id: 'glacier', name: 'Glacier', primary: '#d8f3ff', secondary: '#7fc8ff', accent: '#9effe9' },
];

export function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

export function prefersReducedMotion(theme: HoloTheme): boolean {
  return theme.reduced_motion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Push the theme into CSS custom properties used by every HUD element. */
export function applyThemeCss(theme: HoloTheme): void {
  const root = document.documentElement.style;
  root.setProperty('--p', theme.primary);
  root.setProperty('--s', theme.secondary);
  root.setProperty('--a', theme.accent);
  root.setProperty('--p-rgb', rgb(theme.primary));
  root.setProperty('--s-rgb', rgb(theme.secondary));
  root.setProperty('--a-rgb', rgb(theme.accent));
  root.setProperty('--glow', String(theme.glow));
  document.documentElement.classList.toggle('reduced-motion', prefersReducedMotion(theme));
}
