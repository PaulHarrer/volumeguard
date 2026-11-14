import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { MESSAGE, isExtensionMessage } from '@/lib/messages';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    let context: AudioContext | null = null;
    let gain: GainNode | null = null;
    let currentGain = 1;
    let armed = false;
    const attached = new WeakSet<HTMLMediaElement>();

    function graph(): { context: AudioContext; gain: GainNode } {
      if (!context || !gain) {
        context = new AudioCtx();
        gain = context.createGain();
        gain.gain.value = currentGain;
        gain.connect(context.destination);
      }
      return { context, gain };
    }

    function setGain(value: number): void {
      currentGain = value;
      armed = true;
      if (gain) gain.gain.value = value;
      void graph().context.resume();
    }

    function attach(element: HTMLMediaElement): void {
      if (!armed || attached.has(element)) return;
      try {
        const { context: ctx, gain: node } = graph();
        const source = ctx.createMediaElementSource(element);
        source.connect(node);
        attached.add(element);
        void ctx.resume();
      } catch {
        attached.add(element);
      }
    }

    function scan(root: ParentNode = document): void {
      root.querySelectorAll('audio, video').forEach((node) => {
        attach(node as HTMLMediaElement);
      });
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node instanceof HTMLMediaElement) attach(node);
          else scan(node);
        }
      }
    });

    document.addEventListener(
      'play',
      (event) => {
        if (event.target instanceof HTMLMediaElement) attach(event.target);
      },
      true,
    );

    browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      if (!isExtensionMessage(raw) || raw.type !== MESSAGE.applyGain) return;
      setGain(raw.gain);
      scan();
      sendResponse({ ok: true });
    });

    const root = document.documentElement;
    if (root) observer.observe(root, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }, { once: true });
  },
});
