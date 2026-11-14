interface PageEngine {
  gain: number;
  armed: boolean;
  ctx: AudioContext | null;
  node: GainNode | null;
  nodes: GainNode[];
  hooked: WeakSet<HTMLMediaElement>;
  blocked: WeakSet<HTMLMediaElement>;
  originals: WeakMap<HTMLMediaElement, number>;
  observer: MutationObserver | null;
  watched: WeakSet<Node>;
  patched: boolean;
  bound: boolean;
  gestureBound: boolean;
}

function engine(): PageEngine {
  const host = window as Window & { __vg?: PageEngine };
  if (!host.__vg) {
    host.__vg = {
      gain: 1,
      armed: false,
      ctx: null,
      node: null,
      nodes: [],
      hooked: new WeakSet(),
      blocked: new WeakSet(),
      originals: new WeakMap(),
      observer: null,
      watched: new WeakSet(),
      patched: false,
      bound: false,
      gestureBound: false,
    };
  }
  return host.__vg;
}

function audioCtor(): typeof AudioContext | undefined {
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

function writeGain(node: GainNode, value: number): void {
  const now = node.context.currentTime;
  node.gain.cancelScheduledValues(now);
  if (value === 0) {
    node.gain.setValueAtTime(0, now);
    return;
  }
  node.gain.setTargetAtTime(value, now, 0.015);
}

function mediaSource(el: HTMLMediaElement): string {
  return el.currentSrc || el.src || '';
}

function isPlaying(el: HTMLMediaElement): boolean {
  return !el.paused && !el.ended && el.readyState > 0;
}

function canHook(el: HTMLMediaElement): boolean {
  const withKeys = el as HTMLMediaElement & { mediaKeys?: MediaKeys | null };
  if (withKeys.mediaKeys) return false;
  const src = mediaSource(el);
  if (!src) return false;
  if (src.startsWith('blob:') || src.startsWith('mediasource:')) return true;
  try {
    if (new URL(src, location.href).origin === location.origin) return true;
  } catch {
    return false;
  }
  return el.crossOrigin === 'anonymous' || el.crossOrigin === 'use-credentials';
}

function attenuate(state: PageEngine, el: HTMLMediaElement): boolean {
  if (state.hooked.has(el)) return false;
  if (!state.originals.has(el)) state.originals.set(el, el.volume);
  const base = state.originals.get(el) ?? 1;
  if (state.gain >= 1) {
    el.volume = base;
    return false;
  }
  el.volume = Math.max(0, Math.min(1, base * state.gain));
  return true;
}

async function mediaGraph(state: PageEngine): Promise<GainNode | null> {
  const Ctor = audioCtor();
  if (!Ctor) return null;
  if (!state.ctx || !state.node) {
    const ctx = new Ctor();
    const node = ctx.createGain();
    node.gain.value = state.gain;
    node.connect(ctx.destination);
    state.ctx = ctx;
    state.node = node;
    state.nodes.push(node);
  }
  writeGain(state.node, state.gain);
  if (state.ctx.state !== 'running') {
    try {
      await state.ctx.resume();
    } catch {
      return null;
    }
  }
  return state.ctx.state === 'running' ? state.node : null;
}

function watchGesture(state: PageEngine): void {
  if (state.gestureBound) return;
  state.gestureBound = true;
  document.addEventListener(
    'pointerdown',
    () => {
      void applyPageGain(state.gain);
    },
    true,
  );
}

async function hook(state: PageEngine, el: HTMLMediaElement): Promise<'hooked' | 'attenuated' | 'missed' | 'idle'> {
  if (state.hooked.has(el)) return 'hooked';
  const active = isPlaying(el) || Boolean(mediaSource(el));
  if (!active) return 'idle';
  if (state.blocked.has(el) || !canHook(el)) {
    if (attenuate(state, el)) return 'attenuated';
    return isPlaying(el) ? 'missed' : 'idle';
  }
  const node = await mediaGraph(state);
  if (!node || !state.ctx) {
    watchGesture(state);
    if (attenuate(state, el)) return 'attenuated';
    return isPlaying(el) ? 'missed' : 'idle';
  }
  try {
    const source = state.ctx.createMediaElementSource(el);
    source.connect(node);
    state.hooked.add(el);
    if (state.originals.has(el)) el.volume = state.originals.get(el) ?? el.volume;
    return 'hooked';
  } catch {
    state.blocked.add(el);
    if (attenuate(state, el)) return 'attenuated';
    return isPlaying(el) ? 'missed' : 'idle';
  }
}

function watch(state: PageEngine, root: Node): void {
  if (!state.observer || state.watched.has(root)) return;
  try {
    state.observer.observe(root, { childList: true, subtree: true });
    state.watched.add(root);
  } catch {
    return;
  }
}

function scan(state: PageEngine, root: ParentNode, pending: Promise<'hooked' | 'attenuated' | 'missed' | 'idle'>[]): void {
  root.querySelectorAll('audio, video').forEach((node) => {
    pending.push(hook(state, node as HTMLMediaElement));
  });
  root.querySelectorAll('*').forEach((node) => {
    const shadow = (node as Element).shadowRoot;
    if (!shadow) return;
    watch(state, shadow);
    scan(state, shadow, pending);
  });
}

function bind(state: PageEngine): void {
  if (state.bound) return;
  state.bound = true;
  state.observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLMediaElement) void hook(state, node);
        else if (node instanceof HTMLElement) scan(state, node, []);
      }
    }
  });
  const onMedia = (event: Event): void => {
    if (event.target instanceof HTMLMediaElement) void hook(state, event.target);
  };
  document.addEventListener('play', onMedia, true);
  document.addEventListener('loadedmetadata', onMedia, true);
  const root = document.documentElement;
  if (root) watch(state, root);
}

function patchDestination(state: PageEngine): void {
  if (state.patched || typeof AudioNode === 'undefined') return;
  state.patched = true;
  const native = AudioNode.prototype.connect as (
    this: AudioNode,
    destination: AudioNode | AudioParam,
    output?: number,
    input?: number,
  ) => AudioNode;
  const gains = new WeakMap<BaseAudioContext, GainNode>();

  const gainFor = (ctx: BaseAudioContext): GainNode => {
    const existing = gains.get(ctx);
    if (existing) {
      writeGain(existing, state.gain);
      return existing;
    }
    const created = ctx.createGain();
    created.gain.value = state.gain;
    native.call(created, ctx.destination);
    gains.set(ctx, created);
    state.nodes.push(created);
    return created;
  };

  AudioNode.prototype.connect = function (
    this: AudioNode,
    destination: AudioNode | AudioParam,
    output?: number,
    input?: number,
  ): AudioNode {
    if (state.armed && destination instanceof AudioNode && destination === this.context.destination) {
      const gain = gainFor(this.context);
      if (this !== gain) return native.call(this, gain, output, input);
    }
    return native.call(this, destination, output, input);
  };
}

/**
 * Applies gain in the page that runs this function. Safe to call again: later calls only
 * update the stored gain and attach elements that were not hooked yet.
 * Returns false only when audio is already playing and this call could not change it.
 */
export async function applyPageGain(gain: number): Promise<boolean> {
  const next = Number.isFinite(gain) ? gain : 1;
  const host = window as Window & { __vg?: PageEngine };
  if (!host.__vg && next === 1) return true;

  const state = engine();
  state.gain = next;
  if (state.gain !== 1) state.armed = true;
  for (const node of state.nodes) writeGain(node, state.gain);
  patchDestination(state);
  bind(state);

  const pending: Promise<'hooked' | 'attenuated' | 'missed' | 'idle'>[] = [];
  const root = document.documentElement;
  if (root) scan(state, root, pending);
  const results = await Promise.all(pending);

  if (state.gain === 1 || results.some((result) => result === 'hooked' || result === 'attenuated')) return true;
  const playingMissed = results.some((result) => result === 'missed');
  return !playingMissed;
}
