<p align="center" style="margin-bottom: 0px !important;">
  <img width="128" src="public/icon/128.png" alt="Volume Guard icon" align="center">
</p>
<h1 align="center" style="margin-top: 0px;margin-bottom: 0px;">Volume Guard</h1>
<h2 align="center" style="margin-top: 0px;">
    Boost and control volume in browser up to 600%
</h2>

<p align="center">
    <picture><source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/group/github/stars/PaulHarrer/volumeguard+github/forks/PaulHarrer/volumeguard+github/license/PaulHarrer/volumeguard.svg?variant=outline&amp;mode=dark"><img alt="github group" src="https://shieldcn.dev/group/github/stars/PaulHarrer/volumeguard+github/forks/PaulHarrer/volumeguard+github/license/PaulHarrer/volumeguard.svg?variant=outline&amp;mode=light"></picture>
</p>

---

Boost and control volume from 0% to 600% on any Chrome or Firefox tab. 100% is the page's normal level.

## Functionality

Open the toolbar popup on a tab and set that tab's volume.

- Drag the slider from 0 to 600. Double-click it to reset to 100%. Scroll over it to step by 5%.
- Mute drops the tab to 0%. Click again to restore the last non-zero level.
- Presets: 100%, 200%, 300%, and 600%.
- The toolbar badge shows the level when it is not 100%. `MUTE` means 0%. Blue is under 100%, amber is 101% to 200%, red is above 200%. At 100% the badge is empty.
- Other tabs that are playing audio are listed in the popup. Click one to switch to it.
- **Save for this site** stores the current level for that hostname (`www.` is ignored). The next time you open that site, the saved level is applied. Update replaces it. Remove clears it. Saved sites are listed at the bottom of the popup.
- A level you set by hand stays with that tab as you move around, until you land on a site that has its own saved level. Leaving a site whose level was applied automatically, onto a site with nothing saved, returns the tab to 100%.
- Saved site levels stay in this browser profile. They are not synced. Tab levels last for the browser session.

On Chrome, Volume Guard captures the tab and plays it back through an offscreen document with a gain stage and a limiter. That is how levels above 100% work when the page will not expose its media elements. If capture fails, it falls back to adjusting audio inside the page. Capture needs the popup gesture. If Chrome says the extension has not been invoked, open Volume Guard on that tab and try again.

Firefox has no tab capture. Volume Guard adjusts `<audio>`, `<video>`, and Web Audio output inside the page instead. Firefox 109 or newer is required.

Some audio cannot be boosted above 100%: cross-origin media without CORS, and DRM streams that use MediaKeys. Those can still be lowered when the element volume is writable. Browser pages such as `chrome://` and `about:` cannot be controlled. If another extension is already capturing the tab, Chrome capture is blocked.

## Build

The project uses [Bun](https://bun.sh) 1.4.4 (`packageManager` in package.json).

```sh
bun install
```

| Command | What it does |
| --- | --- |
| `bun run dev` | Chrome dev build with reload |
| `bun run dev:firefox` | Firefox dev build with reload |
| `bun run build` | Production build for Chrome |
| `bun run build:firefox` | Production build for Firefox |
| `bun run zip` | Zip the Chrome build |
| `bun run zip:firefox` | Zip the Firefox build |
| `bun run compile` | Typecheck, no emit |

WXT writes the unpacked extension to:

- Chrome: `.output/chrome-mv3`
- Firefox: `.output/firefox-mv3`

`zip` writes the archive under `.output/`. The manifest version comes from `package.json` (1.1.0).

Load the unpacked extension:

- Chrome: `chrome://extensions`, turn on Developer mode, Load unpacked, select `.output/chrome-mv3`.
- Firefox: `about:debugging#/runtime/this-firefox`, Load Temporary Add-on, select `manifest.json` inside `.output/firefox-mv3`.

MIT licensed. See `LICENSE`.
