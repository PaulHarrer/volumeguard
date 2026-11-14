import { browser } from 'wxt/browser';
import { MESSAGE, isExtensionMessage } from '@/lib/messages';

interface TabAudio {
  context: AudioContext;
  gain: GainNode;
  stream: MediaStream;
}

const tabs = new Map<number, TabAudio>();

async function stop(tabId: number): Promise<void> {
  const current = tabs.get(tabId);
  if (!current) return;
  tabs.delete(tabId);
  current.stream.getTracks().forEach((track) => track.stop());
  await current.context.close().catch(() => undefined);
}

async function start(tabId: number, streamId: string, gainValue: number): Promise<void> {
  await stop(tabId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as MediaTrackConstraints,
    video: false,
  });

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  gain.gain.value = gainValue;
  source.connect(gain);
  gain.connect(context.destination);
  await context.resume();

  const notifyEnded = () => {
    void browser.runtime.sendMessage({ type: MESSAGE.captureEnded, tabId }).catch(() => undefined);
  };
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', notifyEnded);
  });

  tabs.set(tabId, { context, gain, stream });
}

function setGain(tabId: number, gainValue: number): void {
  const current = tabs.get(tabId);
  if (current) current.gain.gain.value = gainValue;
}

browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!isExtensionMessage(raw)) return;

  if (raw.type === MESSAGE.offscreenGain && raw.tabId < 0) {
    sendResponse({ ok: true });
    return;
  }

  if (raw.type === MESSAGE.offscreenStart) {
    void start(raw.tabId, raw.streamId, raw.gain)
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse({ error: String(error) }));
    return true;
  }

  if (raw.type === MESSAGE.offscreenGain) {
    setGain(raw.tabId, raw.gain);
    sendResponse({ ok: true });
    return;
  }

  if (raw.type === MESSAGE.offscreenStop) {
    void stop(raw.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
});
