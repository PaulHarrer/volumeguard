import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import {
  AUDIO_PORT,
  MESSAGE,
  isExtensionMessage,
  type AudioCommand,
  type AudioEvent,
  type AudioReply,
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
  getMediaStreamId: (
    options: { targetTabId?: number },
    callback?: (streamId: string) => void,
  ) => Promise<string> | void;
  getCapturedTabs?: () => Promise<Array<{ tabId: number; status: string }>>;
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

interface ChromeRuntime {
  lastError?: { message?: string };
  getURL: (path: string) => string;
  sendMessage: (message: unknown, callback?: (response: unknown) => void) => void;
}

interface ChromeAPI {
  tabCapture?: ChromeTabCapture;
  offscreen?: ChromeOffscreen;
  runtime: ChromeRuntime;
}

const chromeAPI = (globalThis as unknown as { chrome?: ChromeAPI }).chrome;
const STORAGE_KEY = 'tabVolumes';
const ENGINE_FILE = '/audio-engine.js';
const volumes = new Map<number, number>();
const capturing = new Set<number>();
const contentArmed = new Set<number>();
const engineReady = new Set<string>();
const desired = new Map<number, number>();
const runs = new Map<number, Promise<void>>();
const streamSlots = new Map<number, Promise<string>>();
const pendingReplies = new Map<number, (reply: AudioReply) => void>();
let audioPort: Browser.runtime.Port | null = null;
let commandId = 0;
let creatingEngine: Promise<void> | null = null;

function canCapture(): boolean {
  return Boolean(chromeAPI?.tabCapture?.getMediaStreamId && chromeAPI.offscreen);
}

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

function userError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/has not been invoked/i.test(message)) return 'Open Volume Guard on this tab, then try again';
  if (/already being captured|active stream/i.test(message)) {
    return 'Another extension is already capturing this tab';
  }
  return 'Cannot control volume on this page';
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

function hostOf(url?: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function toTabInfo(tab: BrowserTab, activeId: number | undefined): TabVolumeInfo | null {
  if (tab.id == null) return null;
  return {
    id: tab.id,
    title: tab.title || tab.url || 'Untitled',
    host: hostOf(tab.url),
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Must be called in the same turn as the popup gesture. Awaiting first makes Chrome
 * reject getMediaStreamId with "has not been invoked".
 */
function requestStreamId(tabId: number): Promise<string> {
  const capture = chromeAPI?.tabCapture;
  if (!capture?.getMediaStreamId || !chromeAPI) {
    return Promise.reject(new Error('Tab capture is not available'));
  }

  return withTimeout(
    new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const succeed = (id: string): void => {
        if (settled || !id) return;
        settled = true;
        resolve(id);
      };

      try {
        const result = capture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          const message = chromeAPI.runtime.lastError?.message;
          if (message || !id) fail(new Error(message || 'Could not capture this tab'));
          else succeed(id);
        });
        if (result && typeof result.then === 'function') void result.then(succeed, fail);
      } catch (error) {
        fail(error);
      }
    }),
    3000,
    'Could not capture this tab',
  );
}

function nudgeOffscreen(): void {
  try {
    chromeAPI?.runtime.sendMessage({ target: 'offscreen', op: 'reconnect' }, () => {
      void chromeAPI?.runtime.lastError;
    });
  } catch {
    return;
  }
}

function bindAudioPort(port: Browser.runtime.Port): void {
  audioPort = port;
  port.onMessage.addListener((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const event = raw as Partial<AudioEvent & AudioReply>;
    if (event.event === 'ended' && typeof event.tabId === 'number') {
      capturing.delete(event.tabId);
      return;
    }
    if (typeof event.id !== 'number' || typeof event.ok !== 'boolean') return;
    const waiter = pendingReplies.get(event.id);
    if (!waiter) return;
    pendingReplies.delete(event.id);
    waiter({ id: event.id, ok: event.ok, error: event.error });
  });
  port.onDisconnect.addListener(() => {
    if (audioPort === port) audioPort = null;
    for (const [id, waiter] of pendingReplies) {
      pendingReplies.delete(id);
      waiter({ id, ok: false, error: 'Audio engine disconnected' });
    }
  });
}

function audioCall(command: Omit<AudioCommand, 'id'>): Promise<void> {
  const port = audioPort;
  if (!port) return Promise.reject(new Error('Audio engine is not connected'));
  const id = ++commandId;
  return withTimeout(
    new Promise((resolve, reject) => {
      pendingReplies.set(id, (reply) => {
        if (reply.ok) resolve();
        else reject(new Error(reply.error || 'Audio engine failed'));
      });
      try {
        port.postMessage({ ...command, id } satisfies AudioCommand);
      } catch (error) {
        pendingReplies.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }),
    4000,
    'Audio engine did not respond',
  );
}

async function ensureAudioEngine(): Promise<void> {
  const offscreen = chromeAPI?.offscreen;
  if (!offscreen) throw new Error('Offscreen documents are not supported');

  if (!creatingEngine) {
    creatingEngine = (async () => {
      const exists = offscreen.hasDocument ? await offscreen.hasDocument() : false;
      if (exists) return;
      try {
        await offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
          justification: 'Play captured tab audio with adjustable volume.',
        });
      } catch (error) {
        const message = String(error);
        if (!message.includes('single offscreen') && !message.includes('already exists')) throw error;
      }
    })().finally(() => {
      creatingEngine = null;
    });
  }
  await creatingEngine;
  nudgeOffscreen();

  for (let attempt = 0; attempt < 40; attempt++) {
    if (audioPort) {
      try {
        await audioCall({ op: 'ping' });
        return;
      } catch {
        audioPort = null;
      }
    }
    await delay(50);
  }
  throw new Error('Audio engine did not start');
}

async function stopCapture(tabId: number): Promise<void> {
  capturing.delete(tabId);
  if (!audioPort) return;
  try {
    await audioCall({ op: 'stop', tabId });
  } catch {
    capturing.delete(tabId);
  }
}

async function startCapture(
  tabId: number,
  volume: number,
  streamIdPromise?: Promise<string>,
): Promise<void> {
  await ensureAudioEngine();
  const gain = volumeToGain(volume);
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const streamId = attempt === 0 && streamIdPromise ? await streamIdPromise : await requestStreamId(tabId);
      await audioCall({ op: 'start', tabId, streamId, gain });
      capturing.add(tabId);
      return;
    } catch (error) {
      lastError = error;
      capturing.delete(tabId);
      if (attempt === 0) await delay(150);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Could not capture this tab');
}

function callPageGain(gain: number): boolean | 'missing' | Promise<boolean> {
  const apply = (globalThis as { __vgApply?: (value: number) => Promise<boolean> | boolean }).__vgApply;
  return apply ? apply(gain) : 'missing';
}

async function runEngine(tabId: number, gain: number, world: 'MAIN' | 'ISOLATED'): Promise<boolean> {
  if (!browser.scripting?.executeScript) return false;
  const key = `${tabId}:${world}`;
  if (!engineReady.has(key)) {
    await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      world,
      files: [ENGINE_FILE],
    });
    engineReady.add(key);
  }
  const results = await browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    world,
    func: callPageGain,
    args: [gain],
  });
  if (results.length > 0 && results.every((item) => item.result === 'missing')) {
    engineReady.delete(key);
    throw new Error('Audio engine did not load');
  }
  return results.some((item) => item.result === true);
}

async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    if (!browser.scripting?.executeScript) return false;
    await browser.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['/content-scripts/content.js'],
    });
    return true;
  } catch {
    return false;
  }
}

async function messageContent(tabId: number, gain: number): Promise<boolean> {
  const message = { type: MESSAGE.applyGain, gain } satisfies ExtensionMessage;
  try {
    const response = (await browser.tabs.sendMessage(tabId, message)) as { ok?: boolean } | undefined;
    return Boolean(response?.ok);
  } catch {
    if (!(await injectContentScript(tabId))) return false;
    try {
      const response = (await browser.tabs.sendMessage(tabId, message)) as { ok?: boolean } | undefined;
      return Boolean(response?.ok);
    } catch {
      return false;
    }
  }
}

async function releasePageGain(tabId: number): Promise<void> {
  try {
    await runEngine(tabId, 1, 'MAIN');
  } catch {
    await messageContent(tabId, 1).catch(() => undefined);
  }
}

async function applyContentGain(tabId: number, volume: number): Promise<void> {
  const gain = volumeToGain(volume);
  let controlled = false;
  try {
    controlled = await runEngine(tabId, gain, 'MAIN');
  } catch {
    engineReady.delete(`${tabId}:MAIN`);
    try {
      controlled = await runEngine(tabId, gain, 'ISOLATED');
    } catch {
      engineReady.delete(`${tabId}:ISOLATED`);
      controlled = await messageContent(tabId, gain);
    }
  }
  if (!controlled && gain !== 1) throw new Error('Cannot control volume on this page');
  if (controlled) contentArmed.add(tabId);
}

async function applyVolume(
  tabId: number,
  volume: number,
  streamIdPromise?: Promise<string>,
): Promise<void> {
  const next = clampVolume(volume);
  volumes.set(tabId, next);
  await persistVolumes();
  await updateBadge(tabId, next);

  if (next === DEFAULT_VOLUME) {
    await stopCapture(tabId);
    if (contentArmed.has(tabId)) {
      try {
        await applyContentGain(tabId, next);
      } catch {
        contentArmed.delete(tabId);
      }
    }
    return;
  }

  if (canCapture()) {
    if (capturing.has(tabId)) {
      try {
        await audioCall({ op: 'gain', tabId, gain: volumeToGain(next) });
        if (contentArmed.has(tabId)) {
          contentArmed.delete(tabId);
          void applyContentGain(tabId, DEFAULT_VOLUME).catch(() => undefined);
        }
        return;
      } catch {
        capturing.delete(tabId);
      }
    }
    try {
      await startCapture(tabId, next, streamIdPromise);
      contentArmed.delete(tabId);
      void releasePageGain(tabId);
      return;
    } catch (error) {
      capturing.delete(tabId);
      try {
        await applyContentGain(tabId, next);
        return;
      } catch {
        throw error;
      }
    }
  }

  await applyContentGain(tabId, next);
}

function enqueueVolume(tabId: number, volume: number, streamIdPromise?: Promise<string>): Promise<void> {
  desired.set(tabId, volume);
  const existing = runs.get(tabId);
  if (existing) return existing;

  const run = (async () => {
    let stream = streamIdPromise;
    while (desired.has(tabId)) {
      const target = desired.get(tabId);
      if (target == null) return;
      desired.delete(tabId);
      await applyVolume(tabId, target, stream);
      stream = undefined;
    }
  })();

  runs.set(tabId, run);
  void run.finally(() => {
    if (runs.get(tabId) === run) runs.delete(tabId);
    streamSlots.delete(tabId);
    const latest = desired.get(tabId);
    if (latest != null) void enqueueVolume(tabId, latest);
  });
  return run;
}

async function focusTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.get(tabId);
  if (tab.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
  await browser.tabs.update(tabId, { active: true });
}

export default defineBackground(() => {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== AUDIO_PORT) return;
    if (port.sender?.id !== browser.runtime.id || port.sender.tab) return;
    const senderUrl = port.sender.url ?? '';
    if (senderUrl && !senderUrl.includes('offscreen.html')) return;
    bindAudioPort(port);
  });

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
        await enqueueVolume(tabId, volume);
      } catch {
        continue;
      }
    }
    await persistVolumes();
  });

  browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    if (!isExtensionMessage(raw)) return;

    if (raw.type === MESSAGE.getState) {
      if (canCapture()) void ensureAudioEngine().catch(() => undefined);
      void getPopupState()
        .then((state) => sendResponse(state))
        .catch(() => sendResponse(undefined));
      return true;
    }

    if (raw.type === MESSAGE.setVolume) {
      const volume = clampVolume(raw.volume);
      let streamIdPromise: Promise<string> | undefined;
      if (
        canCapture() &&
        volume !== DEFAULT_VOLUME &&
        !capturing.has(raw.tabId) &&
        !runs.has(raw.tabId) &&
        !streamSlots.has(raw.tabId)
      ) {
        streamIdPromise = requestStreamId(raw.tabId);
        streamSlots.set(raw.tabId, streamIdPromise);
      }
      void enqueueVolume(raw.tabId, volume, streamIdPromise)
        .then(() => getPopupState())
        .then((state) => sendResponse(state))
        .catch(async (error: unknown) => {
          const failed = await getPopupState();
          failed.error = userError(error);
          sendResponse(failed);
        });
      return true;
    }

    if (raw.type === MESSAGE.focusTab) {
      void focusTab(raw.tabId)
        .then(() => getPopupState())
        .then((state) => sendResponse(state))
        .catch(() => sendResponse(undefined));
      return true;
    }

    return;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    volumes.delete(tabId);
    desired.delete(tabId);
    contentArmed.delete(tabId);
    engineReady.delete(`${tabId}:MAIN`);
    engineReady.delete(`${tabId}:ISOLATED`);
    streamSlots.delete(tabId);
    void persistVolumes();
    void stopCapture(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'loading') return;
    capturing.delete(tabId);
    engineReady.delete(`${tabId}:MAIN`);
    engineReady.delete(`${tabId}:ISOLATED`);
    const volume = getVolume(tabId);
    if (volume === DEFAULT_VOLUME) return;
    void enqueueVolume(tabId, volume).catch(() => undefined);
  });
});
