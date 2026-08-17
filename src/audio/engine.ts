/* Cadence audio engine.
 * Design rules baked in here:
 *  - The scheduler only *queues* WebAudio nodes — no heavy work on the audio path.
 *  - The exact same renderStep() drives live playback AND offline WAV export.
 *  - Track graphs are lazily built and cheap (a handful of native nodes each),
 *    so the whole DAW runs happily on integrated graphics / low-end CPUs. */

import { Project, Track } from "../types";
import { encodeWav, makeDriveCurve, makeImpulse, playDrum, playNote } from "./synth";

interface TrackNodes {
  input: GainNode;
  filter: BiquadFilterNode;
  shaper: WaveShaperNode;
  pan: StereoPannerNode;
  out: GainNode;
  analyser: AnalyserNode;
  delaySend: GainNode;
  delay: DelayNode;
  reverbSend: GainNode;
  lastDrive: number;
  levelBuf: Uint8Array;
}

const AHEAD = 0.12; // seconds of lookahead
const TICK = 25; // ms scheduler interval
const MAX_VOICES_PER_STEP = 30;

/** Shared between live playback and offline rendering. */
export function renderStep(
  ctx: BaseAudioContext,
  p: Project,
  absStep: number,
  time: number,
  stepDur: number,
  getInput: (trackId: string) => AudioNode | null,
): void {
  const total = p.lengthBars * 16;
  const s = ((absStep % total) + total) % total;
  const bar = Math.floor(s / 16);
  const soloAny = p.tracks.some((t) => t.solo);
  let budget = MAX_VOICES_PER_STEP;

  for (const t of p.tracks) {
    if (budget <= 0) break;
    const audible = soloAny ? t.solo : !t.mute;
    if (!audible) continue;
    const input = getInput(t.id);
    if (!input) continue;
    for (const pl of t.placements) {
      const clip = p.clips[pl.clipId];
      if (!clip) continue;
      const rel = s - pl.bar * 16;
      if (rel < 0 || rel >= clip.lengthBars * 16) continue;
      for (const n of clip.notes) {
        if (budget <= 0) break;
        if (n.start !== rel) continue;
        budget--;
        if (t.instrument === "drumkit") {
          playDrum(ctx, input, n.pitch, time, n.vel);
        } else {
          playNote(ctx, input, t.instrument, n.pitch, time, Math.max(0.06, n.dur * stepDur), n.vel);
        }
      }
    }
  }
}

class CadenceEngine {
  ctx: AudioContext | null = null;
  private busIn!: GainNode;
  private comp!: DynamicsCompressorNode;
  private masterAnalyser!: AnalyserNode;
  private reverb!: ConvolverNode;
  private nodes = new Map<string, TrackNodes>();
  private project: Project | null = null;

  playing = false;
  loop = true;
  private timer: number | null = null;
  private scheduledStep = 0;
  private nextTime = 0;
  private stoppedStep = 0;
  private stopToken = 0;
  private loadEma = 0;
  private masterBuf: Uint8Array = new Uint8Array(2048);

  onTransport: ((playing: boolean) => void) | null = null;

  /* ---------------- lifecycle ---------------- */
  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.busIn = this.ctx.createGain();
      this.busIn.gain.value = 0.9;
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -10;
      this.comp.knee.value = 22;
      this.comp.ratio.value = 3.5;
      this.comp.attack.value = 0.004;
      this.comp.release.value = 0.18;
      this.masterAnalyser = this.ctx.createAnalyser();
      this.masterAnalyser.fftSize = 2048;
      this.busIn.connect(this.comp);
      this.comp.connect(this.masterAnalyser);
      this.masterAnalyser.connect(this.ctx.destination);
      this.reverb = this.ctx.createConvolver();
      this.reverb.buffer = makeImpulse(this.ctx);
      const revGain = this.ctx.createGain();
      revGain.gain.value = 0.9;
      this.reverb.connect(revGain);
      revGain.connect(this.busIn);
      if (this.project) this.syncTracks(this.project);
    }
    return this.ctx;
  }

  setProject(p: Project): void {
    const prev = this.project;
    this.project = p;
    if (!this.ctx) return;
    this.syncTracks(p);
    if (this.playing && prev && prev.bpm !== p.bpm) {
      // re-anchor the grid so tempo changes stay glitch-free
      const cur = this.getCurrentStep();
      const sd = this.stepDur();
      this.scheduledStep = Math.ceil(cur);
      this.nextTime = this.ctx.currentTime + Math.max(0, this.scheduledStep - cur) * sd;
    }
  }

  private syncTracks(p: Project): void {
    const ctx = this.ctx!;
    const alive = new Set(p.tracks.map((t) => t.id));
    for (const [id, n] of this.nodes) {
      if (!alive.has(id)) {
        try { n.input.disconnect(); n.out.disconnect(); n.analyser.disconnect(); } catch { /* noop */ }
        this.nodes.delete(id);
      }
    }
    for (const t of p.tracks) {
      let n = this.nodes.get(t.id);
      if (!n) {
        n = this.buildTrack();
        this.nodes.set(t.id, n);
      }
      this.applyTrackParams(t, n);
    }
  }

  private buildTrack(): TrackNodes {
    const ctx = this.ctx!;
    const input = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 18000;
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDriveCurve(0);
    shaper.oversample = "2x";
    const dry = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const out = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const delaySend = ctx.createGain();
    delaySend.gain.value = 0;
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.29;
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 0;

    input.connect(filter);
    filter.connect(shaper);
    shaper.connect(dry);
    dry.connect(pan);
    pan.connect(out);
    out.connect(analyser);
    analyser.connect(this.busIn);
    shaper.connect(delaySend);
    delaySend.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(pan);
    shaper.connect(reverbSend);
    reverbSend.connect(this.reverb);

    return { input, filter, shaper, pan, out, analyser, delaySend, delay, reverbSend, lastDrive: 0, levelBuf: new Uint8Array(512) };
  }

  private applyTrackParams(t: Track, n: TrackNodes): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    n.out.gain.setTargetAtTime(t.volume, now, 0.02);
    n.pan.pan.setTargetAtTime(t.pan, now, 0.02);
    n.filter.frequency.setTargetAtTime(t.fx.cutoff, now, 0.02);
    n.delaySend.gain.setTargetAtTime(t.fx.delay * 0.55, now, 0.02);
    n.reverbSend.gain.setTargetAtTime(t.fx.reverb * 0.7, now, 0.02);
    if (Math.abs(t.fx.drive - n.lastDrive) > 0.005) {
      n.shaper.curve = makeDriveCurve(t.fx.drive);
      n.lastDrive = t.fx.drive;
    }
  }

  /* ---------------- transport ---------------- */
  private stepDur(): number {
    return 60 / (this.project?.bpm ?? 120) / 4;
  }

  play(): void {
    const ctx = this.ensureCtx();
    void ctx.resume();
    if (this.playing) return;
    this.playing = true;
    this.stopToken++;
    this.scheduledStep = Math.floor(this.stoppedStep);
    this.nextTime = ctx.currentTime + 0.08;
    this.timer = window.setInterval(() => this.tick(), TICK);
    this.onTransport?.(true);
  }

  pause(): void {
    if (!this.playing) return;
    this.stoppedStep = Math.floor(this.getCurrentStep());
    this.halt();
  }

  stop(): void {
    this.stoppedStep = 0;
    this.halt();
  }

  private halt(): void {
    if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
    if (this.playing) {
      this.playing = false;
      this.onTransport?.(false);
    }
  }

  private tick(): void {
    const ctx = this.ctx!;
    const p = this.project;
    if (!p) return;
    const t0 = performance.now();
    const sd = this.stepDur();
    const total = p.lengthBars * 16;
    while (this.nextTime < ctx.currentTime + AHEAD) {
      const abs = this.scheduledStep;
      if (this.loop || abs < total) {
        renderStep(ctx, p, abs, this.nextTime, sd, (id) => this.nodes.get(id)?.input ?? null);
      } else {
        // non-looping playback reached the end
        const token = this.stopToken;
        window.setTimeout(() => { if (this.stopToken === token) this.stop(); }, Math.max(0, (this.nextTime - ctx.currentTime) * 1000));
        break;
      }
      this.scheduledStep++;
      this.nextTime += sd;
    }
    const dt = performance.now() - t0;
    this.loadEma = this.loadEma * 0.9 + (dt / TICK) * 0.1;
  }

  getCurrentStep(): number {
    const p = this.project;
    if (!p) return 0;
    const total = p.lengthBars * 16;
    if (!this.playing || !this.ctx) return this.stoppedStep % total;
    const frac = this.scheduledStep - (this.nextTime - this.ctx.currentTime) / this.stepDur();
    return ((frac % total) + total) % total;
  }

  /* ---------------- live preview (keyboard / pads) ---------------- */
  previewNote(trackId: string, midi: number, vel: number, durSec = 8): { stop: () => void } {
    const ctx = this.ensureCtx();
    void ctx.resume();
    const p = this.project;
    const t = p?.tracks.find((tr) => tr.id === trackId);
    const input = this.nodes.get(trackId)?.input ?? null;
    const dest = input ?? this.busIn;
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
    const amp = ctx.createGain();
    amp.connect(dest);
    const inst = t?.instrument ?? "pluck";
    if (inst === "drumkit") {
      playDrum(ctx, amp, midi % 5, ctx.currentTime, vel);
      return { stop: () => undefined };
    }
    playNote(ctx, amp, inst, midi, ctx.currentTime, durSec, vel);
    return {
      stop: () => {
        const now = ctx.currentTime;
        amp.gain.cancelScheduledValues(now);
        amp.gain.setValueAtTime(Math.max(amp.gain.value, 0.0001), now);
        amp.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
        window.setTimeout(() => { try { amp.disconnect(); } catch { /* noop */ } }, 400);
      },
    };
  }

  /* ---------------- metering & diagnostics ---------------- */
  getTrackLevel(trackId: string): number {
    const n = this.nodes.get(trackId);
    if (!n) return 0;
    n.analyser.getByteTimeDomainData(n.levelBuf as Uint8Array<ArrayBuffer>);
    return rms(n.levelBuf);
  }

  getMasterLevel(): number {
    if (!this.ctx) return 0;
    this.masterAnalyser.getByteTimeDomainData(this.masterBuf as Uint8Array<ArrayBuffer>);
    return rms(this.masterBuf);
  }

  /** Fill `out` with the master frequency spectrum (0..255 per bin). Cheap: one memcpy from the analyser. */
  getSpectrum(out: Uint8Array): void {
    if (!this.ctx) { out.fill(0); return; }
    this.masterAnalyser.getByteFrequencyData(out as Uint8Array<ArrayBuffer>);
  }

  getLoad(): number { return Math.min(1, this.loadEma); }

  getLatencyMs(): number {
    if (!this.ctx) return 0;
    const base = this.ctx.baseLatency ?? 0.005;
    return Math.round((base + 128 / this.ctx.sampleRate) * 1000);
  }

  getSampleRate(): number { return this.ctx?.sampleRate ?? 0; }

  /* ---------------- offline render / export ---------------- */
  async exportWav(p: Project): Promise<Blob> {
    const sr = 44100;
    const stepDur = 60 / p.bpm / 4;
    const seconds = p.lengthBars * 16 * stepDur + 2.4;
    const octx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);

    const bus = octx.createGain();
    bus.gain.value = 0.9;
    const comp = octx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.18;
    bus.connect(comp);
    comp.connect(octx.destination);
    const reverb = octx.createConvolver();
    reverb.buffer = makeImpulse(octx);
    const revGain = octx.createGain();
    revGain.gain.value = 0.9;
    reverb.connect(revGain);
    revGain.connect(bus);

    const inputs = new Map<string, AudioNode>();
    for (const t of p.tracks) {
      const input = octx.createGain();
      const filter = octx.createBiquadFilter();
      filter.type = "lowpass"; filter.frequency.value = t.fx.cutoff;
      const shaper = octx.createWaveShaper();
      shaper.curve = makeDriveCurve(t.fx.drive);
      const pan = octx.createStereoPanner();
      pan.pan.value = t.pan;
      const out = octx.createGain();
      out.gain.value = t.volume;
      const delaySend = octx.createGain();
      delaySend.gain.value = t.fx.delay * 0.55;
      const delay = octx.createDelay(1.5);
      delay.delayTime.value = 0.29;
      const fb = octx.createGain();
      fb.gain.value = 0.34;
      const reverbSend = octx.createGain();
      reverbSend.gain.value = t.fx.reverb * 0.7;

      input.connect(filter); filter.connect(shaper); shaper.connect(pan);
      pan.connect(out); out.connect(bus);
      shaper.connect(delaySend); delaySend.connect(delay);
      delay.connect(fb); fb.connect(delay); delay.connect(pan);
      shaper.connect(reverbSend); reverbSend.connect(reverb);
      inputs.set(t.id, input);
    }

    const total = p.lengthBars * 16;
    for (let s = 0; s < total; s++) {
      renderStep(octx, p, s, 0.05 + s * stepDur, stepDur, (id) => inputs.get(id) ?? null);
    }
    const rendered = await octx.startRendering();
    return encodeWav(rendered);
  }
}

function rms(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

let singleton: CadenceEngine | null = null;
export function getEngine(): CadenceEngine {
  if (!singleton) singleton = new CadenceEngine();
  return singleton;
}
export type { CadenceEngine };
