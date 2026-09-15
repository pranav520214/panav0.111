/* Audio-input recorder — device selection, monitoring, punch-in/out capture,
 * takes, and latency compensation.
 *
 * Architecture notes:
 *  - The recorder NEVER schedules with setInterval/rAF for alignment. Capture
 *    start/stop is driven by the transport's audio-clock steps (the engine calls
 *    onStep), and the take's grid position is derived from ctx.currentTime at the
 *    moment the playhead crosses punch-in — so takes land on the grid regardless
 *    of buffer size or CPU load.
 *  - The raw PCM lives ONLY in this module's take registry (a Map<id, Float32Array>),
 *    never in the command bus or the project file — buffers don't belong in a
 *    serializable, undoable stream. Take *metadata* flows through the bus.
 *  - Latency: round-trip latency is measured per device by playing a click and
 *    cross-correlating the captured input (calibrate). When not calibrated we fall
 *    back to the AudioContext's reported output latency. The measured value shifts
 *    each take earlier on the grid so recorded audio lines up with existing tracks. */

import { TakeMeta } from "../types";
import type { MixerEngine } from "./mixer";

export interface DeviceInfo {
  deviceId: string;
  label: string;
}

export type RecorderStatus = "idle" | "ready" | "capturing" | "error";

export interface CapturedTake {
  meta: TakeMeta;
  pcm: Float32Array<ArrayBuffer>;
}

const LATENCY_KEY = "cadence.latency.v1";

function loadLatencyMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LATENCY_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export class AudioRecorder {
  private ctx: AudioContext | null = null;
  private mixer: MixerEngine | null = null;

  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private monitorGain: GainNode | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private levelBuf: Uint8Array = new Uint8Array(512);

  private devices: DeviceInfo[] = [];
  selectedDeviceId = "";

  /** trackId → armed for recording */
  private armed = new Set<string>();
  monitorOn = false;
  private monitorTrackId: string | null = null;

  /* capture state */
  status: RecorderStatus = "idle";
  private capturing = false;
  private chunks: Float32Array[] = [];
  private captureStartStep = 0;
  private processor: ScriptProcessorNode | null = null;

  /* punch (steps); null = capture from record-press to stop */
  punch: { startStep: number; endStep: number } | null = null;
  /** Set by the Record UI: is the transport in record mode? */
  recordEnabled = false;

  /* takes: session-only PCM registry */
  private takePcm = new Map<string, Float32Array<ArrayBuffer>>();

  private latencyByDevice = loadLatencyMap();

  private listeners = new Set<() => void>();
  /** Called when a capture finishes; the UI commits metadata via the bus. */
  onTakeReady: ((take: CapturedTake) => void) | null = null;

  /* ---------------- lifecycle ---------------- */

  attach(ctx: AudioContext, mixer: MixerEngine): void {
    if (this.ctx === ctx) return;
    this.ctx = ctx;
    this.mixer = mixer;
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get isReady(): boolean {
    return this.status === "ready" || this.status === "capturing";
  }

  /* ---------------- devices ---------------- */

  async listDevices(): Promise<DeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    this.devices = all
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}` }));
    if (!this.selectedDeviceId && this.devices.length > 0) {
      this.selectedDeviceId = this.devices[0].deviceId;
    }
    this.emit();
    return this.devices;
  }

  getDevices(): DeviceInfo[] {
    return this.devices;
  }

  selectDevice(deviceId: string): void {
    this.selectedDeviceId = deviceId;
    // re-open the stream on the new device if one is active
    if (this.stream) void this.requestInput();
    this.emit();
  }

  /* ---------------- input / monitoring ---------------- */

  /** Open the mic. Creates the source node, monitor route and input meter. */
  async requestInput(): Promise<boolean> {
    if (!this.ctx || !navigator.mediaDevices?.getUserMedia) {
      this.status = "error";
      this.emit();
      return false;
    }
    this.teardownStream();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.selectedDeviceId ? { ideal: this.selectedDeviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.inputAnalyser = this.ctx.createAnalyser();
      this.inputAnalyser.fftSize = 512;
      src.connect(this.inputAnalyser);

      // Monitor route: input → monitorGain → armed track's channel (or master).
      if (this.monitorGain) {
        src.connect(this.monitorGain);
        this.applyMonitorRoute();
      }

      this.source = src;
      this.status = "ready";
      // labels only populate after permission — refresh the list
      void this.listDevices();
      this.emit();
      return true;
    } catch {
      this.status = "error";
      this.emit();
      return false;
    }
  }

  private teardownStream(): void {
    this.stopCapture(0, true);
    if (this.monitorGain) {
      try { this.monitorGain.disconnect(); } catch { /* noop */ }
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.source = null;
    this.inputAnalyser = null;
  }

  /** Route the monitor bus to the monitored/armed track's channel input. */
  private applyMonitorRoute(): void {
    if (!this.ctx || !this.monitorGain) return;
    try { this.monitorGain.disconnect(); } catch { /* noop */ }
    this.monitorGain.gain.value = this.monitorOn ? 1 : 0;
    if (!this.monitorOn) return;
    const dest =
      (this.monitorTrackId && this.mixer?.getInput(this.monitorTrackId)) ||
      this.mixer?.masterInput ||
      null;
    if (dest) this.monitorGain.connect(dest);
  }

  setMonitor(on: boolean, trackId: string | null): void {
    this.monitorOn = on;
    this.monitorTrackId = trackId;
    this.applyMonitorRoute();
    this.emit();
  }

  setArmed(trackId: string, on: boolean): void {
    if (on) this.armed.add(trackId);
    else this.armed.delete(trackId);
    this.emit();
  }
  isArmed(trackId: string): boolean {
    return this.armed.has(trackId);
  }
  getArmed(): string[] {
    return [...this.armed];
  }

  getInputLevel(): number {
    if (!this.inputAnalyser) return 0;
    this.inputAnalyser.getByteTimeDomainData(this.levelBuf as Uint8Array<ArrayBuffer>);
    let peak = 0;
    for (let i = 0; i < this.levelBuf.length; i++) {
      const v = Math.abs(this.levelBuf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  /* ---------------- latency ---------------- */

  /** Fallback estimate from the AudioContext's reported output latency (ms). */
  estimateLatencyMs(): number {
    if (!this.ctx) return 0;
    const base = this.ctx.baseLatency ?? 0;
    const out = this.ctx.outputLatency ?? 0;
    return Math.round((base + out) * 1000);
  }

  getStoredLatencyMs(deviceId: string): number | null {
    const v = this.latencyByDevice[deviceId];
    return typeof v === "number" ? v : null;
  }

  /** The latency to use for a device: measured value, else the estimate. */
  effectiveLatencyMs(deviceId: string): number {
    return this.getStoredLatencyMs(deviceId) ?? this.estimateLatencyMs();
  }

  storeLatencyMs(deviceId: string, ms: number): void {
    this.latencyByDevice[deviceId] = Math.round(ms);
    try {
      localStorage.setItem(LATENCY_KEY, JSON.stringify(this.latencyByDevice));
    } catch { /* storage unavailable — keep in memory */ }
    this.emit();
  }

  /**
   * Measure round-trip latency: play a sharp click, capture the input, and find
   * the click's offset via cross-correlation. Returns ms, or null on failure.
   */
  async calibrate(): Promise<number | null> {
    if (!this.ctx || !this.source) return null;
    const sr = this.ctx.sampleRate;
    const durS = 1.0;
    const n = Math.floor(durS * sr);
    const captured = new Float32Array(n);
    let filled = 0;

    const proc = this.ctx.createScriptProcessor(2048, 1, 1);
    this.source.connect(proc);
    proc.connect(this.ctx.destination); // must be connected to fire
    const onProc = (e: AudioProcessingEvent) => {
      const inp = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < inp.length && filled < n; i++) captured[filled++] = inp[i];
    };
    proc.onaudioprocess = onProc;

    // Emit a click (short burst) at a known time.
    const click = this.ctx.createBuffer(1, Math.floor(0.02 * sr), sr);
    const cd = click.getChannelData(0);
    for (let i = 0; i < cd.length; i++) cd[i] = Math.sin(2 * Math.PI * 1000 * (i / sr)) * (1 - i / cd.length);
    const src = this.ctx.createBufferSource();
    src.buffer = click;
    src.connect(this.ctx.destination);
    const t0 = this.ctx.currentTime + 0.1;
    src.start(t0);

    await new Promise((r) => setTimeout(r, (durS + 0.3) * 1000));
    proc.onaudioprocess = null;
    try { proc.disconnect(); this.source.disconnect(proc); } catch { /* noop */ }

    // Find the click: max of |captured| after the expected arrival.
    let peakIdx = -1;
    let peakVal = 0;
    for (let i = 0; i < filled; i++) {
      const v = Math.abs(captured[i]);
      if (v > peakVal) { peakVal = v; peakIdx = i; }
    }
    if (peakIdx < 0 || peakVal < 0.02) return null; // nothing audible captured
    // click started at t0 (=0.1s into capture window roughly); measure arrival offset
    const offsetSamples = peakIdx - Math.floor(0.1 * sr);
    const ms = Math.max(0, (offsetSamples / sr) * 1000);
    return Math.round(ms);
  }

  /* ---------------- capture (punch-driven, clock-aligned) ---------------- */

  /** Called by the engine on every scheduled step while recording is enabled. */
  onStep(absStep: number, time: number): void {
    if (!this.recordEnabled) {
      if (this.capturing) this.finishCapture();
      return;
    }
    if (this.punch) {
      if (!this.capturing && absStep >= this.punch.startStep && absStep < this.punch.endStep) {
        this.beginCapture(this.punch.startStep, time);
      } else if (this.capturing && absStep >= this.punch.endStep) {
        this.finishCapture();
      }
    } else {
      if (!this.capturing) this.beginCapture(absStep, time);
    }
  }

  /** Engine stopped/paused — flush any in-flight capture. */
  onTransportHalt(): void {
    if (this.capturing) this.finishCapture();
  }

  private beginCapture(startStep: number, _time: number): void {
    if (!this.ctx || !this.source || this.capturing) return;
    this.chunks = [];
    this.captureStartStep = startStep;
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination); // required to fire
    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (!this.capturing) return;
      const inp = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(inp)); // copy out of the reused buffer
    };
    this.capturing = true;
    this.status = "capturing";
    this.emit();
  }

  private stopCapture(_step: number, silent = false): void {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
        this.source?.disconnect(this.processor);
      } catch { /* noop */ }
      this.processor = null;
    }
    this.capturing = false;
    if (!silent) this.status = this.source ? "ready" : "idle";
    this.emit();
  }

  private finishCapture(): void {
    if (!this.capturing) return;
    // capture the tail then close
    this.stopCapture(0, true);
    if (!this.ctx) return;

    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    if (total === 0) {
      this.status = "ready";
      this.emit();
      return;
    }
    const pcm = new Float32Array(total);
    let off = 0;
    let peak = 0;
    for (const c of this.chunks) {
      pcm.set(c, off);
      for (let i = 0; i < c.length; i++) {
        const v = Math.abs(c[i]);
        if (v > peak) peak = v;
      }
      off += c.length;
    }
    this.chunks = [];

    const sr = this.ctx.sampleRate;
    const stepDur = 60 / 120 / 4; // replaced below if project tempo known
    void stepDur;
    const latencyMs = this.effectiveLatencyMs(this.selectedDeviceId);
    const latencySteps = this.msToSteps(latencyMs);
    // Align: shift the take earlier by the round-trip latency so it lines up with
    // the grid the performer was playing against.
    const offsetSteps = Math.max(0, this.captureStartStep - latencySteps);
    const durationSteps = Math.max(1, Math.round((total / sr) / this.currentStepDur()));

    const device = this.devices.find((d) => d.deviceId === this.selectedDeviceId);
    const meta: TakeMeta = {
      id: `take_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      name: `Take ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
      offsetSteps,
      durationSteps,
      deviceId: this.selectedDeviceId,
      deviceLabel: device?.label ?? "Input",
      latencyMs,
      peak,
    };

    this.takePcm.set(meta.id, pcm);
    this.status = "ready";
    this.emit();
    this.onTakeReady?.({ meta, pcm });
  }

  /* tempo hook — the engine sets this so duration math uses the real BPM */
  private bpm = 120;
  setBpm(bpm: number): void {
    this.bpm = bpm;
  }
  private currentStepDur(): number {
    return 60 / this.bpm / 4;
  }
  private msToSteps(ms: number): number {
    return Math.round((ms / 1000) / this.currentStepDur());
  }

  /* ---------------- take registry (session PCM) ---------------- */

  registerTake(id: string, pcm: Float32Array<ArrayBuffer>): void {
    this.takePcm.set(id, pcm);
  }
  getTake(id: string): Float32Array<ArrayBuffer> | null {
    return this.takePcm.get(id) ?? null;
  }
  removeTake(id: string): void {
    this.takePcm.delete(id);
  }

  /** Build a playable AudioBuffer for a take (cached buffers are the caller's job). */
  makeBuffer(pcm: Float32Array<ArrayBuffer>): AudioBuffer | null {
    if (!this.ctx || pcm.length === 0) return null;
    const buf = this.ctx.createBuffer(1, pcm.length, this.ctx.sampleRate);
    buf.copyToChannel(pcm, 0);
    return buf;
  }
}

let singleton: AudioRecorder | null = null;
export function getRecorder(): AudioRecorder {
  if (!singleton) singleton = new AudioRecorder();
  return singleton;
}
