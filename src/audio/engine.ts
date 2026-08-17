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
import {
  MixerEngine, MeterReading, ReturnInfo,
  buildChannel, buildReturn, buildMaster, RETURN_DEFS, isAudible, soloActive,
} from "./mixer";
import { encodeWav, playDrum, playNote } from "./synth";

export const DEFAULT_MAX_POLYPHONY = 32;

/**
 * Walk every note that sounds on `absStep` and hand it to `emit`.
 * Shared verbatim by live playback and offline rendering — one code path.
 * The loop itself allocates nothing; `emit` is the only callback.
 */
export function stepNotes(p: Project, absStep: number, emit: (t: Track, n: Note) => void): void {
  const total = p.lengthBars * 16;
  const s = ((absStep % total) + total) % total;
  // Solo/mute semantics live in the mixer (single source of truth).
  const anySolo = soloActive(p.tracks);
  for (const t of p.tracks) {
    if (!isAudible(t, anySolo)) continue;
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
  private mixer: MixerEngine | null = null;
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

  onTransport: ((playing: boolean) => void) | null = null;

  /* ---------------- lifecycle ---------------- */
  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();

      /* Mixer: channel strips, return buses, master bus and metering. The engine
       * only schedules notes into it; it never builds or touches audio nodes. */
      this.mixer = new MixerEngine(this.ctx);

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

      if (this.project) this.mixer.setProject(this.project);
    }
    return this.ctx;
  }

  setProject(p: Project): void {
    const prev = this.project;
    this.project = p;
    if (!this.ctx) return;
    this.mixer?.setProject(p);
    // Re-anchor the grid on tempo change so playback stays glitch-free.
    if (this.clock && prev && prev.bpm !== p.bpm) this.clock.setStepDur(this.stepDur());
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
      const input = this.mixer?.getInput(t.id) ?? null;
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
    const input = this.mixer?.getInput(trackId) ?? null;
    const dest = input ?? this.mixer?.masterInput ?? ctx.destination;
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

  /* ---------------- metering & diagnostics (delegated to the mixer engine) ---------------- */

  /** Peak + RMS for a channel's post-fader tap (reflects volume and mute/solo). */
  getChannelMeter(trackId: string): MeterReading {
    return this.mixer?.getChannelMeter(trackId) ?? { peak: 0, rms: 0 };
  }

  getMasterMeter(): MeterReading {
    return this.mixer?.getMasterMeter() ?? { peak: 0, rms: 0 };
  }

  getReturnMeter(returnId: string): MeterReading {
    return this.mixer?.getReturnMeter(returnId) ?? { peak: 0, rms: 0 };
  }

  getReturnInfos(): ReturnInfo[] {
    return this.mixer?.getReturnInfos() ?? [];
  }

  /* ---------------- FX cost + insert rack (delegated to the mixer) ---------------- */

  getChannelCpuCost(trackId: string): number {
    return this.mixer?.getChannelCpuCost(trackId) ?? 0;
  }
  getBusCpuCost(): number {
    return this.mixer?.getBusCpuCost() ?? 0;
  }
  getTotalCpuCost(): number {
    return this.mixer?.getTotalCpuCost() ?? 0;
  }

  /** RMS-only convenience kept for existing transport meters. */
  getTrackLevel(trackId: string): number {
    return this.getChannelMeter(trackId).rms;
  }

  getMasterLevel(): number {
    return this.getMasterMeter().rms;
  }

  /** Fill `out` with the master frequency spectrum (0..255 per bin). One memcpy, no alloc. */
  getSpectrum(out: Uint8Array): void {
    if (!this.mixer) { out.fill(0); return; }
    this.mixer.getSpectrum(out);
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

    // Reuse the exact live mixer topology (channels → returns → master) so the
    // rendered file matches what the user hears. No analysers/meters offline.
    const master = buildMaster(octx);
    master.comp.connect(octx.destination);
    const returns = RETURN_DEFS.map((d) => buildReturn(octx, d.id, d.name));
    for (const r of returns) r.output.connect(master.busIn);

    const anySolo = soloActive(p.tracks);
    const inputs = new Map<string, AudioNode>();
    for (const t of p.tracks) {
      const ch = buildChannel(octx, master.busIn, returns, t.fx.drive);
      ch.gate.gain.value = isAudible(t, anySolo) ? 1 : 0;
      ch.filter.frequency.value = t.fx.cutoff;
      ch.pan.pan.value = t.pan;
      ch.fader.gain.value = t.volume;
      ch.sends.get("reverb")?.gain.setValueAtTime(t.fx.reverb * 0.7, 0);
      ch.sends.get("delay")?.gain.setValueAtTime(t.fx.delay * 0.55, 0);
      inputs.set(t.id, ch.input);
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

let singleton: CadenceEngine | null = null;
export function getEngine(): CadenceEngine {
  if (!singleton) singleton = new CadenceEngine();
  return singleton;
}
export type { CadenceEngine };
