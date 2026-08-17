/* Cadence audio engine — the real-time core.
 *
 * Architecture (see the modules it composes):
 *  - scheduler.ts  TransportClock: deterministic lookahead scheduling driven by the
 *                  AudioContext clock. The JS timer is only a pump; the clock is truth.
 *  - voicePool.ts  VoicePool: bounded polyphony with oldest/quietest stealing so a
 *                  busy arrangement never melts a low-end CPU.
 *  - profiler.ts   AudioProfiler: allocation-free per-callback CPU timing to catch
 *                  scheduling regressions.
 *
 * Design rules baked in here:
 *  - No heavy work, and no object/buffer allocation, on the audio path. Metering,
 *    spectrum and profiler buffers are all pre-allocated once and reused.
 *  - The exact same per-step note walk drives live playback AND offline WAV export.
 *  - Track graphs are lazily built and cheap (a handful of native nodes each).
 *  - The UI never touches an AudioNode: it calls play/pause/stop/loop/record-arm
 *    and reads transport/metering through these methods only (via core/audio.ts). */

import { InstrumentKind, Note, Project, Track } from "../types";
import { AudioProfiler, ProfilerStats } from "./profiler";
import { TransportClock } from "./scheduler";
import { VoicePool } from "./voicePool";
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

export const DEFAULT_MAX_POLYPHONY = 32;

/**
 * Walk every note that sounds on `absStep` and hand it to `emit`.
 * Shared verbatim by live playback and offline rendering — one code path.
 * The loop itself allocates nothing; `emit` is the only callback.
 */
export function stepNotes(p: Project, absStep: number, emit: (t: Track, n: Note) => void): void {
  const total = p.lengthBars * 16;
  const s = ((absStep % total) + total) % total;
  const soloAny = p.tracks.some((t) => t.solo);
  for (const t of p.tracks) {
    const audible = soloAny ? t.solo : !t.mute;
    if (!audible) continue;
    for (const pl of t.placements) {
      const clip = p.clips[pl.clipId];
      if (!clip) continue;
      const rel = s - pl.bar * 16;
      if (rel < 0 || rel >= clip.lengthBars * 16) continue;
      for (const n of clip.notes) if (n.start === rel) emit(t, n);
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

  /* real-time core */
  private clock: TransportClock | null = null;
  private pool: VoicePool | null = null;
  private profiler = new AudioProfiler(256, 5, 25);

  playing = false;
  loop = true;
  private stoppedStep = 0;
  private recordArmed = false;
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

      /* Voice pool: bounded, stealing, pre-bound builder (no per-note closures). */
      this.pool = new VoicePool(this.ctx, DEFAULT_MAX_POLYPHONY);
      this.pool.setBuilder((ctx, dest, kind, pitch, time, dur, vel) => {
        if (kind === "drumkit") playDrum(ctx, dest, ((pitch % 5) + 5) % 5, time, vel);
        else playNote(ctx, dest, kind, pitch, time, Math.max(0.06, dur), vel);
      });

      /* Scheduler: audio-clock lookahead; the pump is profiled automatically. */
      this.clock = new TransportClock(
        this.ctx,
        {
          onStep: (abs, time) => this.scheduleStep(abs, time),
          onEnded: () => this.handleEnded(),
        },
        () => (this.project?.lengthBars ?? 1) * 16,
        { profiler: this.profiler },
      );
      this.clock.loop = this.loop;

      if (this.project) this.syncTracks(this.project);
    }
    return this.ctx;
  }

  setProject(p: Project): void {
    const prev = this.project;
    this.project = p;
    if (!this.ctx) return;
    this.syncTracks(p);
    // Re-anchor the grid on tempo change so playback stays glitch-free.
    if (this.clock && prev && prev.bpm !== p.bpm) this.clock.setStepDur(this.stepDur());
  }

  private syncTracks(p: Project): void {
    const ctx = this.ctx!;
    void ctx;
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

  /* ---------------- transport (the only surface the UI drives) ---------------- */

  private stepDur(): number {
    return 60 / (this.project?.bpm ?? 120) / 4;
  }

  play(): void {
    const ctx = this.ensureCtx();
    void ctx.resume();
    if (this.playing || !this.clock) return;
    this.playing = true;
    this.clock.loop = this.loop;
    this.clock.play(Math.floor(this.stoppedStep));
    this.onTransport?.(true);
  }

  pause(): void {
    if (!this.playing || !this.clock) return;
    this.stoppedStep = this.clock.pause();
    this.playing = false;
    this.pool?.allNotesOff(this.ctx?.currentTime ?? 0);
    this.onTransport?.(false);
  }

  stop(): void {
    if (this.clock) {
      this.clock.stop();
      this.pool?.allNotesOff(this.ctx?.currentTime ?? 0);
    }
    this.stoppedStep = 0;
    if (this.playing) {
      this.playing = false;
      this.onTransport?.(false);
    }
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    if (this.clock) this.clock.loop = loop;
  }

  /** Arm/disarm recording. The UI transport calls this; note capture reads it. */
  setRecordArm(armed: boolean): void {
    this.recordArmed = armed;
  }

  isRecordArmed(): boolean {
    return this.recordArmed;
  }

  /** Max simultaneous voices before stealing kicks in. */
  setMaxPolyphony(n: number): void {
    this.ensureCtx();
    this.pool?.setMaxPolyphony(n);
  }

  getMaxPolyphony(): number {
    return this.pool?.getMaxPolyphony() ?? DEFAULT_MAX_POLYPHONY;
  }

  getActiveVoices(): number {
    return this.pool?.getActiveCount() ?? 0;
  }

  getStolenVoices(): number {
    return this.pool?.stolenTotal ?? 0;
  }

  getProfilerStats(): ProfilerStats {
    return this.profiler.getStats();
  }

  /** Called by the scheduler when non-looping playback has scheduled everything. */
  private handleEnded(): void {
    // The tail is still ringing; report stopped once the lookahead drains.
    const wait = Math.max(0, (this.clock?.lookahead ?? 0.12) + 0.05) * 1000;
    window.setTimeout(() => {
      if (!this.clock?.isRunning()) {
        this.playing = false;
        this.stoppedStep = 0;
        this.onTransport?.(false);
      }
    }, wait);
  }

  /** Schedule every note of `absStep` at the sample-accurate `time` via the voice pool. */
  private scheduleStep(abs: number, time: number): void {
    const p = this.project;
    const pool = this.pool;
    if (!p || !pool) return;
    const sd = this.clock?.getStepDur() ?? this.stepDur();
    // Per-step note walk. `emit` is one closure per musical step (not per audio
    // buffer); everything inside it routes primitives into the pre-bound pool.
    stepNotes(p, abs, (t, n) => {
      const input = this.nodes.get(t.id)?.input;
      if (!input) return;
      const dur = t.instrument === "drumkit" ? 0.4 : Math.max(0.06, n.dur * sd);
      pool.trigger(input, time, dur, n.vel, t.instrument as InstrumentKind, n.pitch);
    });
  }

  getCurrentStep(): number {
    const p = this.project;
    if (!p) return 0;
    const total = p.lengthBars * 16;
    if (!this.playing || !this.clock) return ((this.stoppedStep % total) + total) % total;
    return ((this.clock.getPosition() % total) + total) % total;
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

  /* ---------------- metering & diagnostics (pre-allocated, allocation-free) ---------------- */
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

  /** Fill `out` with the master frequency spectrum (0..255 per bin). One memcpy, no alloc. */
  getSpectrum(out: Uint8Array): void {
    if (!this.ctx) { out.fill(0); return; }
    this.masterAnalyser.getByteFrequencyData(out as Uint8Array<ArrayBuffer>);
  }

  /** Smoothed scheduling load (0..1), derived from the profiler window. */
  getLoad(): number {
    const s = this.profiler.getStats();
    this.loadEma = this.loadEma * 0.85 + s.peakLoad * 0.15;
    return Math.min(1, this.loadEma);
  }

  getLatencyMs(): number {
    if (!this.ctx) return 0;
    const base = this.ctx.baseLatency ?? 0.005;
    return Math.round((base + 128 / this.ctx.sampleRate) * 1000);
  }

  getSampleRate(): number { return this.ctx?.sampleRate ?? 0; }

  /* ---------------- offline render / export (direct synth, no pool needed) ---------------- */
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
      const time = 0.05 + s * stepDur;
      stepNotes(p, s, (t, n) => {
        const dest = inputs.get(t.id);
        if (!dest) return;
        if (t.instrument === "drumkit") playDrum(octx, dest, n.pitch, time, n.vel);
        else playNote(octx, dest, t.instrument, n.pitch, time, Math.max(0.06, n.dur * stepDur), n.vel);
      });
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
