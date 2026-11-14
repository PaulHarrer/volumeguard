import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { MESSAGE, isExtensionMessage } from '@/lib/messages';
import { applyPageGain } from '@/lib/page-gain';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_start',
  main() {
    browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      if (!isExtensionMessage(raw) || raw.type !== MESSAGE.applyGain) return;
      void applyPageGain(raw.gain)
        .then((ok) => sendResponse({ ok }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    });
  },
});
