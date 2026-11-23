import './style.css';
import { browser } from 'wxt/browser';
import { MESSAGE, type ExtensionMessage, type PopupState, type TabVolumeInfo } from '@/lib/messages';
import { clampVolume, DEFAULT_VOLUME, formatVolume, MAX_VOLUME } from '@/lib/volume';

const slider = document.querySelector<HTMLInputElement>('#slider')!;
const percent = document.querySelector<HTMLElement>('#percent')!;
const muteButton = document.querySelector<HTMLButtonElement>('#mute')!;
const speakerOn = document.querySelector<SVGElement>('#speaker-on')!;
const speakerOff = document.querySelector<SVGElement>('#speaker-off')!;
const tabMark = document.querySelector<HTMLElement>('#tab-mark')!;
const tabTitle = document.querySelector<HTMLElement>('#tab-title')!;
const tabHost = document.querySelector<HTMLElement>('#tab-host')!;
const siteSaveBar = document.querySelector<HTMLElement>('#site-save')!;
const saveSiteButton = document.querySelector<HTMLButtonElement>('#save-site')!;
const saveSiteLabel = document.querySelector<HTMLElement>('#save-site-label')!;
const saveIconOutline = document.querySelector<SVGElement>('#save-icon-outline')!;
const saveIconFilled = document.querySelector<SVGElement>('#save-icon-filled')!;
const removeSiteButton = document.querySelector<HTMLButtonElement>('#remove-site')!;
const tabsList = document.querySelector<HTMLUListElement>('#tabs')!;
const others = document.querySelector<HTMLElement>('#others')!;
const savedSection = document.querySelector<HTMLElement>('#saved-section')!;
const savedCount = document.querySelector<HTMLElement>('#saved-count')!;
const savedList = document.querySelector<HTMLUListElement>('#saved-list')!;
const errorBox = document.querySelector<HTMLElement>('#error')!;
const presetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-volume]'));

const TONE = {
  muted: 'text-accent',
  low: 'text-accent',
  normal: 'text-ink',
  boost: 'text-boost',
  hot: 'text-hot',
} as const;

const SAVE_IDLE = ['border-line', 'bg-surface', 'text-ink', 'hover:border-accent/40'];
const SAVE_SAVED = ['border-accent/40', 'bg-accent/10', 'text-accent'];

const TAB_ROW =
  'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

let currentTabId: number | null = null;
let currentHost = '';
let currentSavedVolume: number | null = null;
let currentVolume = DEFAULT_VOLUME;
let lastAudibleVolume = DEFAULT_VOLUME;
let pendingVolume: number | null = null;

function toneName(volume: number): keyof typeof TONE {
  if (volume === 0 || volume < DEFAULT_VOLUME) return volume === 0 ? 'muted' : 'low';
  if (volume === DEFAULT_VOLUME) return 'normal';
  if (volume <= 200) return 'boost';
  return 'hot';
}

function fillFor(volume: number): string {
  if (volume === 0 || volume < DEFAULT_VOLUME) return 'var(--color-accent)';
  if (volume === DEFAULT_VOLUME) return 'var(--color-ok)';
  if (volume <= 200) return 'var(--color-boost)';
  return 'var(--color-hot)';
}

function initial(tab: Pick<TabVolumeInfo, 'title'>): string {
  return (tab.title.trim().charAt(0) || '?').toUpperCase();
}

function statusLine(tab: TabVolumeInfo): string {
  const host = tab.host || 'This tab';
  if (tab.savedVolume !== null) return `${host} · saved ${formatVolume(tab.savedVolume)}`;
  if (tab.audible || tab.volume !== DEFAULT_VOLUME) return host;
  return `${host} · not playing`;
}

function renderMark(tab: TabVolumeInfo): void {
  tabMark.replaceChildren();
  if (!tab.favIconUrl) {
    tabMark.textContent = initial(tab);
    return;
  }
  const icon = document.createElement('img');
  icon.src = tab.favIconUrl;
  icon.alt = '';
  icon.className = 'size-4 rounded-sm';
  icon.addEventListener('error', () => {
    tabMark.replaceChildren(document.createTextNode(initial(tab)));
  });
  tabMark.append(icon);
}

function renderSiteSave(): void {
  if (!currentHost) {
    siteSaveBar.classList.add('hidden');
    siteSaveBar.classList.remove('flex');
    return;
  }

  siteSaveBar.classList.remove('hidden');
  siteSaveBar.classList.add('flex');

  const formattedCurrent = formatVolume(currentVolume);

  if (currentSavedVolume === null) {
    saveIconOutline.classList.remove('hidden');
    saveIconFilled.classList.add('hidden');
    saveSiteLabel.textContent = `Save for ${currentHost}`;
    saveSiteButton.disabled = false;
    saveSiteButton.setAttribute('aria-pressed', 'false');
    saveSiteButton.title = `Save ${formattedCurrent} for ${currentHost}`;
    saveSiteButton.setAttribute('aria-label', `Save ${formattedCurrent} for ${currentHost}`);
    saveSiteButton.classList.remove(...SAVE_SAVED);
    saveSiteButton.classList.add(...SAVE_IDLE);
    removeSiteButton.classList.add('hidden');
    removeSiteButton.classList.remove('inline-flex');
    return;
  }

  const formattedSaved = formatVolume(currentSavedVolume);
  removeSiteButton.classList.remove('hidden');
  removeSiteButton.classList.add('inline-flex');
  removeSiteButton.title = `Remove saved volume for ${currentHost}`;
  removeSiteButton.setAttribute('aria-label', `Remove saved volume for ${currentHost}`);

  if (currentSavedVolume === currentVolume) {
    saveIconOutline.classList.add('hidden');
    saveIconFilled.classList.remove('hidden');
    saveSiteLabel.textContent = `Saved (${formattedSaved})`;
    saveSiteButton.disabled = true;
    saveSiteButton.setAttribute('aria-pressed', 'true');
    saveSiteButton.title = `Saved ${formattedSaved} for ${currentHost}`;
    saveSiteButton.setAttribute('aria-label', `Saved ${formattedSaved} for ${currentHost}`);
    saveSiteButton.classList.remove(...SAVE_IDLE);
    saveSiteButton.classList.add(...SAVE_SAVED);
    return;
  }

  saveIconOutline.classList.remove('hidden');
  saveIconFilled.classList.add('hidden');
  saveSiteLabel.textContent = `Update to ${formattedCurrent}`;
  saveSiteButton.disabled = false;
  saveSiteButton.setAttribute('aria-pressed', 'false');
  saveSiteButton.title = `Update saved volume for ${currentHost} from ${formattedSaved} to ${formattedCurrent}`;
  saveSiteButton.setAttribute('aria-label', `Update saved volume for ${currentHost} to ${formattedCurrent}`);
  saveSiteButton.classList.remove(...SAVE_SAVED);
  saveSiteButton.classList.add(...SAVE_IDLE);
}

function renderLevel(volume: number): void {
  const value = clampVolume(volume);
  currentVolume = value;
  slider.value = String(value);
  const ratio = value / MAX_VOLUME;
  slider.style.setProperty('--vg-p', `calc(8px + (100% - 16px) * ${ratio})`);
  slider.style.setProperty('--vg-fill', fillFor(value));
  percent.textContent = String(value);
  percent.classList.remove(...Object.values(TONE));
  percent.classList.add(TONE[toneName(value)]);
  speakerOn.classList.toggle('hidden', value === 0);
  speakerOff.classList.toggle('hidden', value !== 0);
  muteButton.setAttribute('aria-label', value === 0 ? 'Unmute' : 'Mute');
  for (const button of presetButtons) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.volume) === value));
  }
  renderSiteSave();
}

function renderCurrent(tab: TabVolumeInfo | null): void {
  if (!tab) {
    tabTitle.textContent = 'No tab';
    tabHost.textContent = 'Open a page to control its volume';
    tabMark.textContent = '?';
    return;
  }
  tabTitle.textContent = tab.title;
  tabTitle.title = tab.title;
  tabHost.textContent = statusLine(tab);
  renderMark(tab);
}

function renderTabs(next: PopupState): void {
  tabsList.replaceChildren();
  const rows = next.tabs.filter((tab) => tab.id !== next.current?.id && tab.audible);
  others.classList.toggle('hidden', rows.length === 0);

  for (const tab of rows) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = TAB_ROW;
    button.dataset.tabId = String(tab.id);
    button.title = tab.title;

    if (tab.favIconUrl) {
      const icon = document.createElement('img');
      icon.src = tab.favIconUrl;
      icon.alt = '';
      icon.className = 'size-4 shrink-0 rounded-sm';
      icon.addEventListener('error', () => icon.remove());
      button.append(icon);
    } else {
      const mark = document.createElement('span');
      mark.className = 'grid size-4 shrink-0 place-items-center rounded-sm bg-surface-2 text-[9px] font-semibold text-muted';
      mark.textContent = initial(tab);
      button.append(mark);
    }

    const title = document.createElement('span');
    title.className = 'min-w-0 flex-1 truncate';
    title.textContent = tab.title;

    const vol = document.createElement('span');
    vol.className = 'shrink-0 text-xs text-muted tabular-nums';
    vol.textContent = formatVolume(tab.volume);

    button.append(title, vol);
    item.append(button);
    tabsList.append(item);
  }
}

function createCloseIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'size-3.5');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z');
  svg.append(path);
  return svg;
}

function renderSavedSites(next: PopupState): void {
  savedList.replaceChildren();
  const sites = next.savedSites ?? [];
  savedSection.classList.toggle('hidden', sites.length === 0);
  savedCount.textContent = String(sites.length);

  for (const site of sites) {
    const item = document.createElement('li');
    item.className = 'flex min-w-0 items-center gap-1 rounded-lg px-2 py-1 hover:bg-surface';

    const host = document.createElement('span');
    const isCurrent = Boolean(next.current?.host && site.host === next.current.host);
    host.className = isCurrent
      ? 'min-w-0 flex-1 truncate text-xs font-medium text-accent'
      : 'min-w-0 flex-1 truncate text-xs text-ink';
    host.textContent = site.host;
    host.title = site.host;

    const vol = document.createElement('span');
    vol.className = 'shrink-0 text-xs text-muted tabular-nums';
    vol.textContent = formatVolume(site.volume);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.removeHost = site.host;
    remove.className =
      'grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';
    remove.setAttribute('aria-label', `Remove saved volume for ${site.host}`);
    remove.title = `Remove saved volume for ${site.host}`;
    remove.append(createCloseIcon());

    item.append(host, vol, remove);
    savedList.append(item);
  }
}

function showError(message?: string): void {
  errorBox.textContent = message ?? '';
  errorBox.classList.toggle('hidden', !message);
}

function applyPopupState(next: PopupState, updateSlider: boolean): void {
  currentTabId = next.current?.id ?? null;
  currentHost = next.current?.host ?? '';
  currentSavedVolume = next.current?.savedVolume ?? null;
  renderCurrent(next.current);
  if (next.current) {
    if (next.current.volume > 0) lastAudibleVolume = next.current.volume;
    if (updateSlider) {
      renderLevel(next.current.volume);
    } else {
      renderSiteSave();
    }
  } else {
    renderSiteSave();
  }
  renderTabs(next);
  renderSavedSites(next);
}

async function request<T>(message: ExtensionMessage): Promise<T> {
  return (await browser.runtime.sendMessage(message)) as T;
}

async function refresh(): Promise<void> {
  const next = await request<PopupState>({ type: MESSAGE.getState });
  if (!next) {
    showError('Cannot control volume on this page');
    return;
  }
  applyPopupState(next, true);
  showError(next.error);

  const queued = pendingVolume;
  pendingVolume = null;
  if (queued != null) {
    await setVolume(queued);
    return;
  }
  if (next.current && next.current.volume !== DEFAULT_VOLUME) {
    await setVolume(next.current.volume, true);
  }
}

async function setVolume(volume: number, quiet = false): Promise<void> {
  const value = clampVolume(volume);
  renderLevel(value);
  if (value > 0) lastAudibleVolume = value;
  if (currentTabId == null) {
    pendingVolume = value;
    return;
  }
  try {
    const next = await request<PopupState>({
      type: MESSAGE.setVolume,
      tabId: currentTabId,
      volume: value,
    });
    if (!next) throw new Error('no response');
    applyPopupState(next, false);
    if (!quiet || next.error) showError(next.error);
  } catch {
    if (!quiet) showError('Cannot control volume on this page');
  }
}

async function saveCurrentSiteVolume(): Promise<void> {
  if (!currentHost) return;
  try {
    const next = await request<PopupState>({
      type: MESSAGE.saveSiteVolume,
      host: currentHost,
      volume: currentVolume,
      tabId: currentTabId ?? undefined,
    });
    if (!next) throw new Error('no response');
    applyPopupState(next, false);
    showError(next.error);
  } catch {
    showError('Could not save volume for this site');
  }
}

async function removeSiteVolume(host: string): Promise<void> {
  if (!host) return;
  try {
    const next = await request<PopupState>({
      type: MESSAGE.removeSiteVolume,
      host,
      tabId: currentTabId ?? undefined,
    });
    if (!next) throw new Error('no response');
    applyPopupState(next, false);
    showError(next.error);
  } catch {
    showError('Could not remove saved volume');
  }
}

slider.addEventListener('input', () => {
  void setVolume(Number(slider.value));
});

slider.addEventListener('dblclick', () => {
  void setVolume(DEFAULT_VOLUME);
});

muteButton.addEventListener('click', () => {
  const current = Number(slider.value);
  void setVolume(current === 0 ? lastAudibleVolume || DEFAULT_VOLUME : 0);
});

for (const button of presetButtons) {
  button.addEventListener('click', () => {
    void setVolume(Number(button.dataset.volume));
  });
}

saveSiteButton.addEventListener('click', () => {
  void saveCurrentSiteVolume();
});

removeSiteButton.addEventListener('click', () => {
  void removeSiteVolume(currentHost);
});

savedList.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-remove-host]');
  if (!button) return;
  const host = button.dataset.removeHost;
  if (host) void removeSiteVolume(host);
});

tabsList.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab-id]');
  if (!button) return;
  const tabId = Number(button.dataset.tabId);
  if (!Number.isFinite(tabId) || tabId === currentTabId) return;
  void request({ type: MESSAGE.focusTab, tabId });
});

slider.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 5 : -5;
    void setVolume(Number(slider.value) + delta);
  },
  { passive: false },
);

void refresh();
