export const MIN_VOLUME = 0;
export const MAX_VOLUME = 600;
export const DEFAULT_VOLUME = 100;

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, Math.round(value)));
}

export function volumeToGain(volume: number): number {
  return clampVolume(volume) / DEFAULT_VOLUME;
}

export function formatVolume(volume: number): string {
  return `${clampVolume(volume)}%`;
}

export function badgeText(volume: number): string {
  const value = clampVolume(volume);
  if (value === DEFAULT_VOLUME) return '';
  if (value === 0) return 'MUTE';
  return String(value);
}

export function badgeColor(volume: number): string {
  const value = clampVolume(volume);
  if (value === 0) return '#4b5563';
  if (value < DEFAULT_VOLUME) return '#2563eb';
  if (value === DEFAULT_VOLUME) return '#16a34a';
  if (value <= 200) return '#d97706';
  return '#dc2626';
}
