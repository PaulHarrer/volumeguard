import { AUDIO_PORT, isAudioCommand, type AudioCommand, type AudioReply } from '@/lib/messages';

interface LiveGraph {
  pending?: false;
  context: AudioContext;
  gain: GainNode;
  stream: MediaStream;
  audio?: HTMLAudioElement;
}

interface PendingGraph {
  pending: true;
  gain: number;
  cancelled: boolean;
  done: Promise<boolean>;
}

type TabGraph = LiveGraph | PendingGraph;

interface ChromeRuntime {
  connect: (info: { name: string }) => ChromePort;
  getURL: (path: string) => string;
  onMessage?: { addListener: (listener: (message: unknown) => void) => void };
}

interface ChromePort {
  postMessage: (message: unknown) => void;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
}

const chromeRuntime = (globalThis as unknown as { chrome?: { runtime: ChromeRuntime } }).chrome?.runtime;
const tabs = new Map<number, TabGraph>();

function reply(port: ChromePort, message: AudioReply): void {
  try {
    port.postMessage(message);
  } catch {
    return;
  }
}

function fail(port: ChromePort, id: number, error: unknown): void {
  reply(port, { id, ok: false, error: error instanceof Error ? error.message : String(error) });
}

async function stop(tabId: number): Promise<void> {
  const current = tabs.get(tabId);
  if (!current) return;
  tabs.delete(tabId);
  if (current.pending) {
    current.cancelled = true;
    await current.done.catch(() => undefined);
    return;
  }
  current.stream.getTracks().forEach((track) => track.stop());
  current.audio?.remove();
  await current.context.close().catch(() => undefined);
}

function writeGain(node: GainNode, value: number, immediate: boolean): void {
  const now = node.context.currentTime;
  node.gain.cancelScheduledValues(now);
  if (immediate || value === 0) {
    node.gain.setValueAtTime(value, now);
    return;
  }
  node.gain.setTargetAtTime(value, now, 0.015);
}

function limiterFor(context: AudioContext): DynamicsCompressorNode {
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.knee.value = 0;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  return limiter;
}

async function start(tabId: number, streamId: string, gainValue: number): Promise<void> {
  const existing = tabs.get(tabId);
  if (existing?.pending) {
    existing.gain = gainValue;
    existing.cancelled = false;
    const ok = await existing.done;
    if (!ok) throw new Error('Could not capture this tab');
    return;
  }
  if (existing && !existing.pending) {
    writeGain(existing.gain, gainValue, false);
    return;
  }

  const entry: PendingGraph = {
    pending: true,
    gain: gainValue,
    cancelled: false,
    done: Promise.resolve(false),
  };
  let settle: (ok: boolean) => void = () => undefined;
  entry.done = new Promise((resolve) => {
    settle = resolve;
  });
  tabs.set(tabId, entry);

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      } as MediaTrackConstraints,
      video: false,
    });
  } catch (error) {
    if (tabs.get(tabId) === entry) tabs.delete(tabId);
    settle(false);
    throw error;
  }

  if (entry.cancelled || tabs.get(tabId) !== entry) {
    stream.getTracks().forEach((track) => track.stop());
    if (tabs.get(tabId) === entry) tabs.delete(tabId);
    settle(false);
    return;
  }

  const context = new AudioContext({ latencyHint: 'interactive' });
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  gain.gain.value = entry.gain;
  const limiter = limiterFor(context);
  source.connect(gain);
  gain.connect(limiter);
  const live: LiveGraph = { context, gain, stream };

  try {
    await context.resume().catch(() => undefined);
    // Capturing a tab mutes its normal output. Route the gained stream back out.
    // Destination is the documented path; an <audio> element covers offscreen
    // documents whose AudioContext stays suspended.
    if (context.state === 'running') {
      limiter.connect(context.destination);
    } else {
      const output = context.createMediaStreamDestination();
      limiter.connect(output);
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.srcObject = output.stream;
      document.body.append(audio);
      await audio.play();
      live.audio = audio;
    }

    if (entry.cancelled || tabs.get(tabId) !== entry) {
      stream.getTracks().forEach((track) => track.stop());
      live.audio?.remove();
      await context.close().catch(() => undefined);
      if (tabs.get(tabId) === entry) tabs.delete(tabId);
      settle(false);
      return;
    }

    stream.getAudioTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (tabs.get(tabId) !== live) return;
        void stop(tabId);
        try {
          port?.postMessage({ event: 'ended', tabId });
        } catch {
          return;
        }
      });
    });

    tabs.set(tabId, live);
    settle(true);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    live.audio?.remove();
    await context.close().catch(() => undefined);
    if (tabs.get(tabId) === entry) tabs.delete(tabId);
    settle(false);
    throw error;
  }
}

function setGain(tabId: number, gainValue: number): boolean {
  const current = tabs.get(tabId);
  if (!current) return false;
  if (current.pending) {
    current.gain = gainValue;
    return true;
  }
  writeGain(current.gain, gainValue, gainValue === 0);
  return true;
}

let port: ChromePort | null = null;

function handle(message: AudioCommand, active: ChromePort): void {
  if (message.op === 'ping') {
    reply(active, { id: message.id, ok: true });
    return;
  }
  if (message.op === 'stop') {
    void stop(message.tabId ?? -1).then(() => reply(active, { id: message.id, ok: true }));
    return;
  }
  if (message.op === 'gain') {
    const ok = message.tabId != null && setGain(message.tabId, message.gain ?? 1);
    reply(active, { id: message.id, ok, error: ok ? undefined : 'Capture is not running' });
    return;
  }
  if (message.op === 'start') {
    if (message.tabId == null || !message.streamId) {
      reply(active, { id: message.id, ok: false, error: 'Missing capture stream' });
      return;
    }
    void start(message.tabId, message.streamId, message.gain ?? 1)
      .then(() => reply(active, { id: message.id, ok: true }))
      .catch((error: unknown) => fail(active, message.id, error));
  }
}

function connect(): void {
  if (!chromeRuntime) return;
  try {
    const next = chromeRuntime.connect({ name: AUDIO_PORT });
    port = next;
    next.onMessage.addListener((raw) => {
      if (!isAudioCommand(raw)) return;
      handle(raw, next);
    });
    next.onDisconnect.addListener(() => {
      if (port === next) port = null;
      setTimeout(connect, 200);
    });
  } catch {
    return;
  }
}

chromeRuntime?.onMessage?.addListener((raw) => {
  if (!raw || typeof raw !== 'object') return;
  if ((raw as { target?: string; op?: string }).target !== 'offscreen') return;
  if ((raw as { op?: string }).op === 'reconnect') connect();
});

connect();
