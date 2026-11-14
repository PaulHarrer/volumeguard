export const MESSAGE = {
  getState: 'vg:get-state',
  setVolume: 'vg:set-volume',
  focusTab: 'vg:focus-tab',
  applyGain: 'vg:apply-gain',
  offscreenStart: 'vg:offscreen-start',
  offscreenGain: 'vg:offscreen-gain',
  offscreenStop: 'vg:offscreen-stop',
  captureEnded: 'vg:capture-ended',
} as const;

export type MessageType = (typeof MESSAGE)[keyof typeof MESSAGE];

export interface TabVolumeInfo {
  id: number;
  title: string;
  favIconUrl?: string;
  audible: boolean;
  muted: boolean;
  volume: number;
  active: boolean;
  windowId: number;
}

export interface PopupState {
  current: TabVolumeInfo | null;
  tabs: TabVolumeInfo[];
  error?: string;
}

export type ExtensionMessage =
  | { type: typeof MESSAGE.getState }
  | { type: typeof MESSAGE.setVolume; tabId: number; volume: number }
  | { type: typeof MESSAGE.focusTab; tabId: number }
  | { type: typeof MESSAGE.applyGain; gain: number }
  | {
      type: typeof MESSAGE.offscreenStart;
      tabId: number;
      streamId: string;
      gain: number;
    }
  | { type: typeof MESSAGE.offscreenGain; tabId: number; gain: number }
  | { type: typeof MESSAGE.offscreenStop; tabId: number }
  | { type: typeof MESSAGE.captureEnded; tabId: number };

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string' &&
    Object.values(MESSAGE).includes((value as { type: MessageType }).type)
  );
}
