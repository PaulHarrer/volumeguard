import type { SavedSiteVolume } from './messages.ts';
import { clampVolume, DEFAULT_VOLUME } from './volume.ts';

export const SITE_VOLUMES_KEY = 'siteVolumes';

export function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase().replace(/^www\./, '');
  if (!value || /[\s/\\]/.test(value)) return '';
  return value;
}

export function hostOf(url?: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return normalizeHost(parsed.hostname);
  } catch {
    return '';
  }
}

export function parseSiteVolumes(raw: unknown): Map<string, number> {
  const result = new Map<string, number>();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return result;

  for (const [key, value] of Object.entries(raw)) {
    const host = normalizeHost(key);
    if (!host || typeof value !== 'number' || !Number.isFinite(value)) continue;
    result.set(host, clampVolume(value));
  }
  return result;
}

export function serializeSiteVolumes(map: ReadonlyMap<string, number>): Record<string, number> {
  const normalized = new Map<string, number>();
  for (const [key, value] of map) {
    const host = normalizeHost(key);
    if (!host || typeof value !== 'number' || !Number.isFinite(value)) continue;
    normalized.set(host, clampVolume(value));
  }

  const out: Record<string, number> = {};
  const hosts = Array.from(normalized.keys()).sort((a, b) => a.localeCompare(b));
  for (const host of hosts) {
    const volume = normalized.get(host);
    if (volume !== undefined) out[host] = volume;
  }
  return out;
}

export function toSavedSiteList(map: ReadonlyMap<string, number>): SavedSiteVolume[] {
  const normalized = new Map<string, number>();
  for (const [key, value] of map) {
    const host = normalizeHost(key);
    if (!host || typeof value !== 'number' || !Number.isFinite(value)) continue;
    normalized.set(host, clampVolume(value));
  }

  return Array.from(normalized.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, volume]) => ({ host, volume }));
}

export interface NavigationDecision {
  hostChanged: boolean;
  nextHost: string;
  nextVolume: number;
  autoApplied: boolean;
  volumeChanged: boolean;
}

export function resolveNavigationVolume(params: {
  prevHost: string | undefined;
  nextHost: string;
  currentVolume: number;
  wasAutoApplied: boolean;
  savedVolume: number | undefined;
}): NavigationDecision {
  const { prevHost, nextHost, currentVolume, wasAutoApplied, savedVolume } = params;
  const hostChanged = prevHost !== nextHost;

  if (!hostChanged) {
    return {
      hostChanged: false,
      nextHost,
      nextVolume: currentVolume,
      autoApplied: wasAutoApplied,
      volumeChanged: false,
    };
  }

  if (nextHost && savedVolume !== undefined) {
    const clamped = clampVolume(savedVolume);
    return {
      hostChanged: true,
      nextHost,
      nextVolume: clamped,
      autoApplied: true,
      volumeChanged: clamped !== currentVolume,
    };
  }

  if (wasAutoApplied) {
    return {
      hostChanged: true,
      nextHost,
      nextVolume: DEFAULT_VOLUME,
      autoApplied: false,
      volumeChanged: DEFAULT_VOLUME !== currentVolume,
    };
  }

  return {
    hostChanged: true,
    nextHost,
    nextVolume: currentVolume,
    autoApplied: false,
    volumeChanged: false,
  };
}
