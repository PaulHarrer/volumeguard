export const MESSAGE = {
  getState: 'vg:get-state',
  setVolume: 'vg:set-volume',
  focusTab: 'vg:focus-tab',
  applyGain: 'vg:apply-gain',
  saveSiteVolume: 'vg:save-site-volume',
  removeSiteVolume: 'vg:remove-site-volume',
  pageReady: 'vg:page-ready',
} as const;

export const AUDIO_PORT = 'vg-audio';

export type MessageType = (typeof MESSAGE)[keyof typeof MESSAGE];

export interface TabVolumeInfo {
  id: number;
  title: string;
  host: string;
  favIconUrl?: string;
  audible: boolean;
  muted: boolean;
  volume: number;
  savedVolume: number | null;
  active: boolean;
  windowId: number;
}

export interface SavedSiteVolume {
  host: string;
  volume: number;
}

export interface PopupState {
  current: TabVolumeInfo | null;
  tabs: TabVolumeInfo[];
  savedSites: SavedSiteVolume[];
  error?: string;
}

export type ExtensionMessage =
  | { type: typeof MESSAGE.getState }
  | { type: typeof MESSAGE.setVolume; tabId: number; volume: number }
  | { type: typeof MESSAGE.focusTab; tabId: number }
  | { type: typeof MESSAGE.applyGain; gain: number }
  | { type: typeof MESSAGE.saveSiteVolume; host: string; volume: number; tabId?: number }
  | { type: typeof MESSAGE.removeSiteVolume; host: string; tabId?: number }
  | { type: typeof MESSAGE.pageReady };

export type AudioOp = 'ping' | 'start' | 'gain' | 'stop';

export interface AudioCommand {
  id: number;
  op: AudioOp;
  tabId?: number;
  streamId?: string;
  gain?: number;
}

export interface AudioReply {
  id: number;
  ok: boolean;
  error?: string;
}

export interface AudioEvent {
  event: 'ended';
  tabId: number;
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string' &&
    Object.values(MESSAGE).includes((value as { type: MessageType }).type)
  );
}

export function isAudioCommand(value: unknown): value is AudioCommand {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'op' in value &&
    typeof (value as { id: unknown }).id === 'number' &&
    typeof (value as { op: unknown }).op === 'string'
  );
}
