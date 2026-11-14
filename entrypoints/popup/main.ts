import { browser } from 'wxt/browser';
import { MESSAGE, type PopupState, type TabVolumeInfo } from '@/lib/messages';
import { clampVolume, DEFAULT_VOLUME, formatVolume } from '@/lib/volume';

const slider = document.querySelector<HTMLInputElement>('#slider')!;
const percent = document.querySelector<HTMLElement>('#percent')!;
const level = document.querySelector<HTMLElement>('.level')!;
const muteButton = document.querySelector<HTMLButtonElement>('#mute')!;
const speakerOn = document.querySelector<SVGElement>('#speaker-on')!;
const speakerOff = document.querySelector<SVGElement>('#speaker-off')!;
const tabsList = document.querySelector<HTMLUListElement>('#tabs')!;
const empty = document.querySelector<HTMLElement>('#empty')!;
const errorBox = document.querySelector<HTMLElement>('#error')!;
const presetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-volume]'));

let currentTabId: number | null = null;
let lastAudibleVolume = DEFAULT_VOLUME;

function toneClass(volume: number): string {
  if (volume === 0) return 'muted';
  if (volume < DEFAULT_VOLUME) return 'low';
  if (volume <= 200) return volume === DEFAULT_VOLUME ? '' : 'boost';
  return 'hot';
}

function renderLevel(volume: number): void {
  const value = clampVolume(volume);
  slider.value = String(value);
  percent.textContent = String(value);
  level.classList.remove('muted', 'low', 'boost', 'hot');
  const tone = toneClass(value);
  if (tone) level.classList.add(tone);
  speakerOn.classList.toggle('hidden', value === 0);
  speakerOff.classList.toggle('hidden', value !== 0);
  muteButton.setAttribute('aria-label', value === 0 ? 'Unmute' : 'Mute');
  for (const button of presetButtons) {
    button.classList.toggle('active', Number(button.dataset.volume) === value);
  }
}

function renderTabs(next: PopupState): void {
  tabsList.replaceChildren();
  const rows = next.tabs;
  empty.classList.toggle('hidden', rows.length > 0);

  for (const tab of rows) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tab${tab.active ? ' active' : ''}`;
    button.dataset.tabId = String(tab.id);

    if (tab.favIconUrl) {
      const icon = document.createElement('img');
      icon.src = tab.favIconUrl;
      icon.alt = '';
      icon.addEventListener('error', () => {
        icon.replaceWith(fallbackIcon(tab));
      });
      button.append(icon);
    } else {
      button.append(fallbackIcon(tab));
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title;

    const vol = document.createElement('span');
    vol.className = 'tab-vol';
    vol.textContent = formatVolume(tab.volume);

    button.append(title, vol);
    item.append(button);
    tabsList.append(item);
  }
}

function fallbackIcon(tab: TabVolumeInfo): HTMLSpanElement {
  const mark = document.createElement('span');
  mark.className = 'tab-fallback';
  mark.textContent = (tab.title.trim().charAt(0) || '?').toUpperCase();
  return mark;
}

function showError(message?: string): void {
  errorBox.textContent = message ?? '';
  errorBox.classList.toggle('hidden', !message);
}

async function request<T>(message: { type: string; tabId?: number; volume?: number }): Promise<T> {
  return (await browser.runtime.sendMessage(message)) as T;
}

async function refresh(): Promise<void> {
  const next = await request<PopupState>({ type: MESSAGE.getState });
  if (!next) {
    showError('Cannot control volume on this page');
    return;
  }
  currentTabId = next.current?.id ?? null;
  if (next.current) {
    if (next.current.volume > 0) lastAudibleVolume = next.current.volume;
    renderLevel(next.current.volume);
  }
  renderTabs(next);
  showError(next.error);
}

async function setVolume(volume: number): Promise<void> {
  if (currentTabId == null) return;
  const value = clampVolume(volume);
  renderLevel(value);
  if (value > 0) lastAudibleVolume = value;
  try {
    const next = await request<PopupState>({
      type: MESSAGE.setVolume,
      tabId: currentTabId,
      volume: value,
    });
    if (!next) throw new Error('no response');
    renderTabs(next);
    showError(next.error);
  } catch {
    showError('Cannot control volume on this page');
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
