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
import {
  hostOf,
  normalizeHost,
  parseSiteVolumes,
  resolveNavigationVolume,
  serializeSiteVolumes,
  SITE_VOLUMES_KEY,
  toSavedSiteList,
} from '@/lib/site-volumes';

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
const TAB_HOSTS_KEY = 'tabHosts';
const AUTO_APPLIED_KEY = 'autoAppliedTabs';
const ENGINE_FILE = '/audio-engine.js';
const volumes = new Map<number, number>();
const tabHosts = new Map<number, string>();
const autoApplied = new Set<number>();
const siteVolumes = new Map<string, number>();
const capturing = new Set<number>();
const contentArmed = new Set<number>();
const engineReady = new Set<string>();
interface VolumeRequest {
  volume: number;
  allowCapture: boolean;
  streamIdPromise?: Promise<string>;
}
const desired = new Map<number, VolumeRequest>();
const runs = new Map<number, Promise<void>>();
const streamSlots = new Map<number, Promise<string>>();
const pendingReplies = new Map<number, (reply: AudioReply) => void>();
let audioPort: Browser.runtime.Port | null = null;
let commandId = 0;
let creatingEngine: Promise<void> | null = null;
let ready: Promise<void> = Promise.resolve();

function canCapture(): boolean {
  return Boolean(chromeAPI?.tabCapture?.getMediaStreamId && chromeAPI.offscreen);
}

function sessionStorage(): typeof browser.storage.local | null {
  const session = (browser.storage as { session?: typeof browser.storage.local }).session;
  return session ?? null;
}

async function persistSessionState(): Promise<void> {
  const area = sessionStorage();
  if (!area) return;
  await area.set({
    [STORAGE_KEY]: Object.fromEntries(volumes),
    [TAB_HOSTS_KEY]: Object.fromEntries(tabHosts),
    [AUTO_APPLIED_KEY]: Array.from(autoApplied),
  });
}

async function loadSessionState(): Promise<void> {
  const area = sessionStorage();
  if (!area) return;
  const data = await area.get([STORAGE_KEY, TAB_HOSTS_KEY, AUTO_APPLIED_KEY]);
  const saved = data[STORAGE_KEY] as Record<string, number> | undefined;
  if (saved && typeof saved === 'object') {
    for (const [id, volume] of Object.entries(saved)) {
      const tabId = Number(id);
      if (Number.isFinite(tabId) && typeof volume === 'number') {
        volumes.set(tabId, clampVolume(volume));
      }
    }
  }
  const savedHosts = data[TAB_HOSTS_KEY] as Record<string, string> | undefined;
  if (savedHosts && typeof savedHosts === 'object') {
    for (const [id, host] of Object.entries(savedHosts)) {
      const tabId = Number(id);
      if (Number.isFinite(tabId) && typeof host === 'string') {
        tabHosts.set(tabId, normalizeHost(host));
      }
    }
  }
  const savedAuto = data[AUTO_APPLIED_KEY] as number[] | undefined;
  if (Array.isArray(savedAuto)) {
    for (const id of savedAuto) {
      if (typeof id === 'number' && Number.isFinite(id)) {
        autoApplied.add(id);
      }
    }
  }
}

async function loadSiteVolumes(): Promise<void> {
  const data = await browser.storage.local.get(SITE_VOLUMES_KEY);
  const parsed = parseSiteVolumes(data[SITE_VOLUMES_KEY]);
  siteVolumes.clear();
  for (const [host, volume] of parsed) {
    siteVolumes.set(host, volume);
  }
}

async function persistSiteVolumes(): Promise<void> {
  await browser.storage.local.set({
    [SITE_VOLUMES_KEY]: serializeSiteVolumes(siteVolumes),
  });
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

function toTabInfo(tab: BrowserTab, activeId: number | undefined): TabVolumeInfo | null {
  if (tab.id == null) return null;
  const host = hostOf(tab.url);
  return {
    id: tab.id,
    title: tab.title || tab.url || 'Untitled',
    host,
    favIconUrl: tab.favIconUrl,
    audible: Boolean(tab.audible),
    muted: Boolean(tab.mutedInfo?.muted),
    volume: getVolume(tab.id),
    savedVolume: host ? (siteVolumes.get(host) ?? null) : null,
    active: tab.id === activeId,
    windowId: tab.windowId,
  };
}

async function getPopupState(): Promise<PopupState> {
  await ready;
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

  return { current, tabs, savedSites: toSavedSiteList(siteVolumes) };
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

function engineKey(tabId: number, world: 'MAIN' | 'ISOLATED', frameId?: number): string {
  return frameId != null ? `${tabId}:${world}:${frameId}` : `${tabId}:${world}`;
}

function clearEngineReady(tabId: number): void {
  const prefix = `${tabId}:`;
  for (const key of engineReady) {
    if (key.startsWith(prefix)) engineReady.delete(key);
  }
}

function scriptTarget(tabId: number, frameId?: number): { tabId: number; allFrames?: boolean; frameIds?: number[] } {
  return frameId != null ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
}

async function runEngine(
  tabId: number,
  gain: number,
  world: 'MAIN' | 'ISOLATED',
  frameId?: number,
): Promise<boolean> {
  if (!browser.scripting?.executeScript) return false;
  const key = engineKey(tabId, world, frameId);
  const target = scriptTarget(tabId, frameId);
  if (!engineReady.has(key)) {
    await browser.scripting.executeScript({
      target,
      world,
      files: [ENGINE_FILE],
    });
    engineReady.add(key);
  }
  const results = await browser.scripting.executeScript({
    target,
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

async function injectContentScript(tabId: number, frameId?: number): Promise<boolean> {
  try {
    if (!browser.scripting?.executeScript) return false;
    await browser.scripting.executeScript({
      target: scriptTarget(tabId, frameId),
      files: ['/content-scripts/content.js'],
    });
    return true;
  } catch {
    return false;
  }
}

async function messageContent(tabId: number, gain: number, frameId?: number): Promise<boolean> {
  const message = { type: MESSAGE.applyGain, gain } satisfies ExtensionMessage;
  const send = (): Promise<unknown> =>
    frameId != null
      ? browser.tabs.sendMessage(tabId, message, { frameId })
      : browser.tabs.sendMessage(tabId, message);
  try {
    const response = (await send()) as { ok?: boolean } | undefined;
    return Boolean(response?.ok);
  } catch {
    if (!(await injectContentScript(tabId, frameId))) return false;
    try {
      const response = (await send()) as { ok?: boolean } | undefined;
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

async function applyContentGain(tabId: number, volume: number, frameId?: number): Promise<void> {
  const gain = volumeToGain(volume);
  let controlled = false;
  try {
    controlled = await runEngine(tabId, gain, 'MAIN', frameId);
  } catch {
    engineReady.delete(engineKey(tabId, 'MAIN', frameId));
    try {
      controlled = await runEngine(tabId, gain, 'ISOLATED', frameId);
    } catch {
      engineReady.delete(engineKey(tabId, 'ISOLATED', frameId));
      controlled = await messageContent(tabId, gain, frameId);
    }
  }
  if (!controlled && gain !== 1) throw new Error('Cannot control volume on this page');
  if (controlled) contentArmed.add(tabId);
}

async function applyVolume(
  tabId: number,
  volume: number,
  options: { allowCapture: boolean; streamIdPromise?: Promise<string> },
): Promise<void> {
  const next = clampVolume(volume);
  volumes.set(tabId, next);
  await persistSessionState();
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
    if (options.allowCapture) {
      try {
        await startCapture(tabId, next, options.streamIdPromise);
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
  }

  await applyContentGain(tabId, next);
}

function enqueueVolume(
  tabId: number,
  volume: number,
  options: { allowCapture: boolean; streamIdPromise?: Promise<string> },
): Promise<void> {
  const prev = desired.get(tabId);
  const allowCapture = options.allowCapture || Boolean(prev?.allowCapture);
  const streamIdPromise =
    options.streamIdPromise ?? (allowCapture ? prev?.streamIdPromise : undefined);
  desired.set(tabId, { volume, allowCapture, streamIdPromise });
  const existing = runs.get(tabId);
  if (existing) return existing;

  const run = (async () => {
    while (desired.has(tabId)) {
      const target = desired.get(tabId);
      if (!target) return;
      desired.delete(tabId);
      await applyVolume(tabId, target.volume, {
        allowCapture: target.allowCapture,
        streamIdPromise: target.streamIdPromise,
      });
    }
  })();

  runs.set(tabId, run);
  void run.finally(() => {
    if (runs.get(tabId) === run) runs.delete(tabId);
    streamSlots.delete(tabId);
    const latest = desired.get(tabId);
    if (latest) {
      desired.delete(tabId);
      void enqueueVolume(tabId, latest.volume, {
        allowCapture: latest.allowCapture,
        streamIdPromise: latest.streamIdPromise,
      });
    }
  });
  return run;
}

async function syncTabForUrl(
  tabId: number,
  url: string | undefined,
  isDocumentLoad: boolean,
): Promise<void> {
  await ready;
  const nextHost = hostOf(url);
  const prevHost = tabHosts.get(tabId);
  const currentVolume = getVolume(tabId);
  const savedVolume = nextHost ? siteVolumes.get(nextHost) : undefined;
  const decision = resolveNavigationVolume({
    prevHost,
    nextHost,
    currentVolume,
    wasAutoApplied: autoApplied.has(tabId),
    savedVolume,
  });

  tabHosts.set(tabId, decision.nextHost);
  if (decision.autoApplied) autoApplied.add(tabId);
  else autoApplied.delete(tabId);
  if (decision.volumeChanged) {
    volumes.set(tabId, decision.nextVolume);
  }

  if (decision.hostChanged || decision.volumeChanged) {
    await persistSessionState();
  }
  await updateBadge(tabId, decision.nextVolume);

  if (decision.volumeChanged) {
    await enqueueVolume(tabId, decision.nextVolume, { allowCapture: false }).catch(() => undefined);
    return;
  }
  if (isDocumentLoad && decision.nextVolume !== DEFAULT_VOLUME && !capturing.has(tabId)) {
    await enqueueVolume(tabId, decision.nextVolume, { allowCapture: false }).catch(() => undefined);
  }
}

async function reconcileOpenTabs(): Promise<void> {
  const allTabs = await browser.tabs.query({});
  const openIds = new Set<number>();
  const tasks: Promise<unknown>[] = [];

  for (const tab of allTabs) {
    if (tab.id != null) openIds.add(tab.id);
  }

  for (const id of Array.from(volumes.keys())) {
    if (!openIds.has(id)) volumes.delete(id);
  }
  for (const id of Array.from(tabHosts.keys())) {
    if (!openIds.has(id)) tabHosts.delete(id);
  }
  for (const id of Array.from(autoApplied)) {
    if (!openIds.has(id)) autoApplied.delete(id);
  }

  for (const tab of allTabs) {
    const tabId = tab.id;
    if (tabId == null) continue;
    const host = hostOf(tab.url);
    if (volumes.has(tabId)) {
      if (!tabHosts.has(tabId)) tabHosts.set(tabId, host);
      const volume = getVolume(tabId);
      tasks.push(updateBadge(tabId, volume));
      if (
        volume !== DEFAULT_VOLUME &&
        !capturing.has(tabId) &&
        !contentArmed.has(tabId) &&
        !runs.has(tabId)
      ) {
        tasks.push(enqueueVolume(tabId, volume, { allowCapture: false }));
      }
    } else if (!tabHosts.has(tabId)) {
      tabHosts.set(tabId, host);
      if (host && siteVolumes.has(host)) {
        const saved = clampVolume(siteVolumes.get(host) ?? DEFAULT_VOLUME);
        volumes.set(tabId, saved);
        autoApplied.add(tabId);
        tasks.push(updateBadge(tabId, saved));
        if (saved !== DEFAULT_VOLUME) {
          tasks.push(enqueueVolume(tabId, saved, { allowCapture: false }));
        }
      }
    }
  }

  await persistSessionState();
  await Promise.allSettled(tasks);
}

function cleanupTabState(tabId: number): void {
  volumes.delete(tabId);
  tabHosts.delete(tabId);
  autoApplied.delete(tabId);
  desired.delete(tabId);
  contentArmed.delete(tabId);
  clearEngineReady(tabId);
  streamSlots.delete(tabId);
  void ready.then(() => persistSessionState());
  void stopCapture(tabId);
}

async function focusTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.get(tabId);
  if (tab.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
  await browser.tabs.update(tabId, { active: true });
}

export default defineBackground(() => {
  ready = Promise.all([loadSessionState(), loadSiteVolumes()]).then(() => undefined);
  void ready.then(reconcileOpenTabs);

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[SITE_VOLUMES_KEY]) return;
    const parsed = parseSiteVolumes(changes[SITE_VOLUMES_KEY].newValue);
    siteVolumes.clear();
    for (const [host, volume] of parsed) {
      siteVolumes.set(host, volume);
    }
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== AUDIO_PORT) return;
    if (port.sender?.id !== browser.runtime.id || port.sender.tab) return;
    const senderUrl = port.sender.url ?? '';
    if (senderUrl && !senderUrl.includes('offscreen.html')) return;
    bindAudioPort(port);
  });

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
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
        !streamSlots.has(raw.tabId)
      ) {
        streamIdPromise = requestStreamId(raw.tabId);
        void streamIdPromise.catch(() => undefined);
        streamSlots.set(raw.tabId, streamIdPromise);
      }
      void ready
        .then(async () => {
          let host = tabHosts.get(raw.tabId);
          if (host === undefined) {
            try {
              const tab = await browser.tabs.get(raw.tabId);
              host = hostOf(tab.url);
              tabHosts.set(raw.tabId, host);
            } catch {
              host = '';
            }
          }
          const saved = host ? siteVolumes.get(host) : undefined;
          if (saved !== volume) {
            autoApplied.delete(raw.tabId);
          }
          await enqueueVolume(raw.tabId, volume, { allowCapture: true, streamIdPromise });
          return getPopupState();
        })
        .then((state) => sendResponse(state))
        .catch(async (error: unknown) => {
          const failed = await getPopupState().catch(() => ({
            current: null,
            tabs: [],
            savedSites: toSavedSiteList(siteVolumes),
          }));
          failed.error = userError(error);
          sendResponse(failed);
        });
      return true;
    }

    if (raw.type === MESSAGE.saveSiteVolume) {
      void ready
        .then(async () => {
          const host = normalizeHost(raw.host);
          if (host) {
            siteVolumes.set(host, clampVolume(raw.volume));
            await persistSiteVolumes();
            if (raw.tabId != null) {
              const currentHost = tabHosts.get(raw.tabId);
              if (!currentHost || currentHost === host) {
                tabHosts.set(raw.tabId, host);
                autoApplied.add(raw.tabId);
                await persistSessionState();
              }
            }
          }
          return getPopupState();
        })
        .then((state) => sendResponse(state))
        .catch(() => sendResponse(undefined));
      return true;
    }

    if (raw.type === MESSAGE.removeSiteVolume) {
      void ready
        .then(async () => {
          const host = normalizeHost(raw.host);
          if (host && siteVolumes.delete(host)) {
            await persistSiteVolumes();
          }
          return getPopupState();
        })
        .then((state) => sendResponse(state))
        .catch(() => sendResponse(undefined));
      return true;
    }

    if (raw.type === MESSAGE.pageReady) {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      const frameId = sender.frameId ?? 0;
      if (frameId === 0) {
        clearEngineReady(tabId);
        contentArmed.delete(tabId);
        void syncTabForUrl(tabId, sender.tab?.url ?? sender.url, true);
      } else {
        void ready.then(async () => {
          const vol = getVolume(tabId);
          if (vol !== DEFAULT_VOLUME && !capturing.has(tabId)) {
            await applyContentGain(tabId, vol, frameId).catch(() => undefined);
          }
        });
      }
      return;
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
    cleanupTabState(tabId);
  });

  browser.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
    cleanupTabState(removedTabId);
    void browser.tabs
      .get(addedTabId)
      .then((tab) => syncTabForUrl(addedTabId, tab.url, true))
      .catch(() => undefined);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading') {
      clearEngineReady(tabId);
      contentArmed.delete(tabId);
      void syncTabForUrl(tabId, changeInfo.url ?? tab.url, true);
      return;
    }
    if (changeInfo.url) {
      void syncTabForUrl(tabId, changeInfo.url, false);
      return;
    }
    if (changeInfo.status === 'complete') {
      void ready.then(async () => {
        const nextHost = hostOf(tab.url);
        if (tabHosts.get(tabId) !== nextHost) {
          await syncTabForUrl(tabId, tab.url, true);
          return;
        }
        const volume = getVolume(tabId);
        await updateBadge(tabId, volume);
        if (volume !== DEFAULT_VOLUME && !capturing.has(tabId) && !contentArmed.has(tabId)) {
          await enqueueVolume(tabId, volume, { allowCapture: false }).catch(() => undefined);
        }
      });
    }
  });
});
