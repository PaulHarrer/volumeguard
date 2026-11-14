import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import {
  MESSAGE,
  isExtensionMessage,
  type ExtensionMessage,
  type PopupState,
  type TabVolumeInfo,
} from '@/lib/messages';
import {
  badgeColor,
  badgeText,
  clampVolume,
  DEFAULT_VOLUME,
  volumeToGain,
} from '@/lib/volume';

interface ChromeTabCapture {
  getMediaStreamId: (options: { targetTabId?: number }) => Promise<string>;
}

interface ChromeOffscreen {
  hasDocument?: () => Promise<boolean>;
  createDocument: (options: {
    url: string;
    reasons: string[];
    justification: string;
  }) => Promise<void>;
  closeDocument: () => Promise<void>;
}

interface ChromeAPI {
  tabCapture?: ChromeTabCapture;
  offscreen?: ChromeOffscreen;
  runtime: { lastError?: { message?: string } };
}

const chromeAPI = (globalThis as unknown as { chrome?: ChromeAPI }).chrome;
const STORAGE_KEY = 'tabVolumes';
const volumes = new Map<number, number>();
const capturing = new Set<number>();
const contentArmed = new Set<number>();
const locks = new Map<number, Promise<void>>();
const useTabCapture = Boolean(chromeAPI?.tabCapture?.getMediaStreamId && chromeAPI.offscreen);

function sessionStorage(): typeof browser.storage.local | null {
  const session = (browser.storage as { session?: typeof browser.storage.local }).session;
  return session ?? null;
}

async function persistVolumes(): Promise<void> {
  const area = sessionStorage();
  if (!area) return;
  await area.set({ [STORAGE_KEY]: Object.fromEntries(volumes) });
}

async function restoreVolumes(): Promise<void> {
  const area = sessionStorage();
  if (!area) return;
  const data = await area.get(STORAGE_KEY);
  const saved = data[STORAGE_KEY] as Record<string, number> | undefined;
  if (!saved) return;
  for (const [id, volume] of Object.entries(saved)) {
    volumes.set(Number(id), clampVolume(volume));
  }
}

function getVolume(tabId: number): number {
  return volumes.get(tabId) ?? DEFAULT_VOLUME;
}

function queue(tabId: number, task: () => Promise<void>): Promise<void> {
  const next = (locks.get(tabId) ?? Promise.resolve()).then(task, task);
  locks.set(tabId, next.catch(() => undefined));
  return next;
}

async function updateBadge(tabId: number, volume: number): Promise<void> {
  try {
    await browser.action.setBadgeText({ tabId, text: badgeText(volume) });
    await browser.action.setBadgeBackgroundColor({ tabId, color: badgeColor(volume) });
  } catch {
    return;
  }
}

interface BrowserTab {
  id?: number;
  title?: string;
  url?: string;
  favIconUrl?: string;
  audible?: boolean;
  mutedInfo?: { muted?: boolean };
  windowId: number;
}

function toTabInfo(tab: BrowserTab, activeId: number | undefined): TabVolumeInfo | null {
  if (tab.id == null) return null;
  return {
    id: tab.id,
    title: tab.title || tab.url || 'Untitled',
    favIconUrl: tab.favIconUrl,
    audible: Boolean(tab.audible),
    muted: Boolean(tab.mutedInfo?.muted),
    volume: getVolume(tab.id),
    active: tab.id === activeId,
    windowId: tab.windowId,
  };
}

async function getPopupState(): Promise<PopupState> {
  const [activeTabs, allTabs] = await Promise.all([
    browser.tabs.query({ active: true, currentWindow: true }),
    browser.tabs.query({}),
  ]);
  const currentTab = activeTabs[0];
  const current = currentTab ? toTabInfo(currentTab, currentTab.id) : null;
  const seen = new Set<number>();
  const tabs: TabVolumeInfo[] = [];

  if (current) {
    tabs.push(current);
    seen.add(current.id);
  }

  for (const tab of allTabs) {
    if (!tab.audible || tab.id == null || seen.has(tab.id)) continue;
    const info = toTabInfo(tab, current?.id);
    if (info) tabs.push(info);
  }

  return { current, tabs };
}

async function pingOffscreen(): Promise<boolean> {
  try {
    const response = (await browser.runtime.sendMessage({
      type: MESSAGE.offscreenGain,
      tabId: -1,
      gain: 1,
    } satisfies ExtensionMessage)) as { ok?: boolean } | undefined;
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function ensureOffscreen(): Promise<void> {
  const offscreen = chromeAPI?.offscreen;
  if (!offscreen) throw new Error('Offscreen documents are not supported');

  const hasDocument = offscreen.hasDocument ? await offscreen.hasDocument() : await pingOffscreen();
  if (hasDocument) return;

  try {
    await offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture tab audio so volume can be boosted past 100%.',
    });
  } catch (error) {
    const message = String(error);
    if (!message.includes('single offscreen') && !message.includes('already exists')) {
      throw error;
    }
  }

  for (let i = 0; i < 20; i++) {
    if (await pingOffscreen()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function sendOffscreen(message: ExtensionMessage): Promise<void> {
  await ensureOffscreen();
  const response = (await browser.runtime.sendMessage(message)) as
    | { ok?: boolean; error?: string }
    | undefined;
  if (response?.error) throw new Error(response.error);
}

async function stopCapture(tabId: number): Promise<void> {
  if (!capturing.has(tabId)) return;
  capturing.delete(tabId);
  try {
    if (await pingOffscreen()) {
      await browser.runtime.sendMessage({ type: MESSAGE.offscreenStop, tabId } satisfies ExtensionMessage);
    }
  } catch {
    capturing.delete(tabId);
  }
  if (capturing.size === 0 && chromeAPI?.offscreen?.closeDocument) {
    try {
      await chromeAPI.offscreen.closeDocument();
    } catch {
      return;
    }
  }
}

async function startCapture(tabId: number, volume: number): Promise<void> {
  if (!chromeAPI?.tabCapture?.getMediaStreamId) {
    throw new Error('Tab capture is not available');
  }
  const streamId = await chromeAPI.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await sendOffscreen({
    type: MESSAGE.offscreenStart,
    tabId,
    streamId,
    gain: volumeToGain(volume),
  });
  capturing.add(tabId);
}

async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    if (browser.scripting?.executeScript) {
      await browser.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['/content-scripts/content.js'],
      });
      return true;
    }
  } catch {
    return false;
  }

  try {
    const tabsApi = browser.tabs as typeof browser.tabs & {
      executeScript?: (
        tabId: number,
        details: { file: string; allFrames?: boolean },
      ) => Promise<unknown>;
    };
    if (!tabsApi.executeScript) return false;
    await tabsApi.executeScript(tabId, {
      file: '/content-scripts/content.js',
      allFrames: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function applyContentGain(tabId: number, volume: number): Promise<void> {
  const message = { type: MESSAGE.applyGain, gain: volumeToGain(volume) } satisfies ExtensionMessage;
  try {
    await browser.tabs.sendMessage(tabId, message);
  } catch {
    if (!(await injectContentScript(tabId))) {
      throw new Error('Cannot control volume on this page');
    }
    await browser.tabs.sendMessage(tabId, message);
  }
}

async function applyVolume(tabId: number, volume: number): Promise<void> {
  const next = clampVolume(volume);
  volumes.set(tabId, next);
  await persistVolumes();
  await updateBadge(tabId, next);

  if (next === DEFAULT_VOLUME) {
    await stopCapture(tabId);
    if (contentArmed.has(tabId)) await applyContentGain(tabId, next);
    return;
  }

  if (useTabCapture) {
    if (capturing.has(tabId)) {
      await sendOffscreen({
        type: MESSAGE.offscreenGain,
        tabId,
        gain: volumeToGain(next),
      });
      return;
    }
    try {
      await startCapture(tabId, next);
      return;
    } catch {
      capturing.delete(tabId);
    }
  }

  await applyContentGain(tabId, next);
  contentArmed.add(tabId);
}

async function focusTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.get(tabId);
  if (tab.windowId != null) {
    await browser.windows.update(tab.windowId, { focused: true });
  }
  await browser.tabs.update(tabId, { active: true });
}

async function handleMessage(
  message: ExtensionMessage,
  sender: { tab?: { id?: number } },
): Promise<PopupState | { ok: true } | undefined> {
  switch (message.type) {
    case MESSAGE.getState:
      return getPopupState();
    case MESSAGE.setVolume:
      try {
        await queue(message.tabId, () => applyVolume(message.tabId, message.volume));
      } catch (error) {
        const failed = await getPopupState();
        failed.error =
          error instanceof Error ? error.message : 'Cannot control volume on this page';
        return failed;
      }
      return getPopupState();
    case MESSAGE.focusTab:
      await focusTab(message.tabId);
      return getPopupState();
    case MESSAGE.captureEnded: {
      const tabId = message.tabId || sender.tab?.id;
      if (tabId != null) capturing.delete(tabId);
      return { ok: true };
    }
    default:
      return undefined;
  }
}

export default defineBackground(() => {
  void restoreVolumes().then(async () => {
    for (const [tabId, volume] of volumes) {
      try {
        await browser.tabs.get(tabId);
      } catch {
        volumes.delete(tabId);
        continue;
      }
      if (volume === DEFAULT_VOLUME) continue;
      try {
        await updateBadge(tabId, volume);
        await queue(tabId, () => applyVolume(tabId, volume));
      } catch {
        continue;
      }
    }
    await persistVolumes();
  });

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    if (!isExtensionMessage(raw)) return;
    if (
      raw.type === MESSAGE.applyGain ||
      raw.type === MESSAGE.offscreenStart ||
      raw.type === MESSAGE.offscreenGain ||
      raw.type === MESSAGE.offscreenStop
    ) {
      return;
    }
    void handleMessage(raw, sender).then(sendResponse).catch(() => sendResponse(undefined));
    return true;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    volumes.delete(tabId);
    locks.delete(tabId);
    contentArmed.delete(tabId);
    void persistVolumes();
    void stopCapture(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' && useTabCapture && capturing.has(tabId)) {
      const volume = getVolume(tabId);
      if (volume !== DEFAULT_VOLUME) {
        void queue(tabId, async () => {
          await stopCapture(tabId);
          await applyVolume(tabId, volume);
        });
      }
    }
  });
});
