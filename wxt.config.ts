import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: '.',
  manifestVersion: 3,
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: ({ browser }) => ({
    name: 'Volume Guard',
    description: 'Boost and control volume up to 600% on any tab.',
    permissions:
      browser === 'firefox'
        ? ['tabs', 'storage', 'scripting']
        : ['tabs', 'storage', 'tabCapture', 'offscreen', 'scripting', 'activeTab'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Volume Guard',
    },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    browser_specific_settings: {
      gecko: {
        id: 'volumeguard@volumeguard.dev',
        strict_min_version: '109.0',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  }),
  hooks: {
    'build:manifestGenerated'(wxt, manifest) {
      if (wxt.config.browser !== 'firefox') return;

      const stripLocalhost = (value: string): string =>
        value.replace(/https?:\/\/localhost(?::\d+)?/g, '').replace(/\s{2,}/g, ' ').trim();

      const csp = manifest.content_security_policy;
      if (typeof csp === 'string') {
        manifest.content_security_policy = stripLocalhost(csp);
      } else if (csp && typeof csp === 'object') {
        const pages = csp as { extension_pages?: string; sandbox?: string };
        if (pages.extension_pages) pages.extension_pages = stripLocalhost(pages.extension_pages);
        if (pages.sandbox) pages.sandbox = stripLocalhost(pages.sandbox);
      }
    },
  },
});
