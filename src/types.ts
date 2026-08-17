/* Cadence — core domain model.
 * Everything the engine, the UI and the AI command system share. */

export type Mode = "beginner" | "producer" | "advanced";

/**
 * Numeric rank so "at least this mode" is a single comparison. Complexity is
 * additive and ordered: Beginner ⊂ Producer ⊂ Advanced. A control visible
 * "from Producer" shows in Producer and Advanced alike — nothing is removed,
 * only progressively disclosed. Components express intent via gate(threshold)
 * instead of comparing mode strings, keeping the ordering in one place.
 */
export const MODE_ORDER: Record<Mode, number> = { beginner: 0, producer: 1, advanced: 2 };

export type ScaleType = "minor" | "major";
export type InstrumentKind = "drumkit" | "bass" | "keys" | "pluck" | "pad";

/** Center workspace views — swappable, one active at a time. */
export type WorkspaceView = "arrangement" | "pianoroll" | "mixer";

export const STEPS_PER_BAR = 16;

/** Drum "pitches" are lane indices. */
export const DRUM_LANES = ["Kick", "Snare", "Hat", "Open Hat", "Clap"] as const;
export type DrumLane = 0 | 1 | 2 | 3 | 4;

export interface Note {
  id: string;
  /** MIDI pitch for melodic tracks, drum lane index for drumkit tracks. */
  pitch: number;
  /** Start position in 1/16 steps, relative to clip start. */
  start: number;
  /** Duration in 1/16 steps. */
  dur: number;
  /** 0..1 */
  vel: number;
}

export interface Clip {
  id: string;
  name: string;
  lengthBars: number;
  notes: Note[];
}

export interface Placement {
  id: string;
  clipId: string;
  bar: number;
}

export interface TrackFx {
  /** reverb send amount 0..1 */
  reverb: number;
  /** delay send amount 0..1 */
  delay: number;
  /** lowpass cutoff Hz */
  cutoff: number;
  /** waveshaper drive 0..1 */
  drive: number;
}

export interface Track {
  id: string;
  name: string;
  color: string;
  instrument: InstrumentKind;
  volume: number; // linear gain 0..1.25
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  fx: TrackFx;
  clipIds: string[];
  /** clip used when painting empty timeline cells */
  sourceClipId: string;
  placements: Placement[];
}

export interface TimeSignature {
  numerator: number;   // beats per bar
  denominator: number; // beat unit (2, 4, 8, 16)
}

export type AutomationParam = "volume" | "pan" | "reverb" | "delay" | "cutoff" | "drive";

export interface AutomationEvent {
  step: number; // absolute 16th-note step on the timeline
  value: number; // normalized 0..1 (interpreted per param)
}

export interface AutomationLane {
  id: string;
  trackId: string;
  param: AutomationParam;
  points: AutomationEvent[];
}

export interface Project {
  name: string;
  bpm: number;
  rootMidi: number;
  scale: ScaleType;
  lengthBars: number;
  timeSignature: TimeSignature;
  automation: AutomationLane[];
  tracks: Track[];
  clips: Record<string, Clip>;
  /** Epoch ms — surfaced as ISO strings in the file format's metadata block. */
  createdAt: number;
  modifiedAt: number;
}

/* ---------------- command system ----------------
 * The mutation vocabulary lives in the core layer (src/core/commands.ts).
 * User gestures and the AI copilot both emit Commands; the command bus
 * validates them, applies them through pure executors, and makes every
 * batch a single atomic undo entry. The alias below keeps older imports
 * (AI layer, panels) compiling unchanged. */
export type { Command as DawCommand } from "./core/commands";

export const INSTRUMENT_META: Record<
  InstrumentKind,
  { label: string; color: string; hint: string; icon: string }
> = {
  drumkit: { label: "Drum Machine", color: "#ff6f61", hint: "Kick, snare, hats & claps", icon: "drum" },
  bass: { label: "Bass Synth", color: "#ffb45e", hint: "Deep sub & acid bass", icon: "wave" },
  keys: { label: "Keys", color: "#3ecfb2", hint: "Warm chords & stabs", icon: "keys" },
  pluck: { label: "Pluck Lead", color: "#58b7f5", hint: "Melodic lead line", icon: "pluck" },
  pad: { label: "Air Pad", color: "#a78bfa", hint: "Soft ambient texture", icon: "pad" },
};

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const midiName = (m: number) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
export const dbLabel = (v: number) => (v <= 0.0001 ? "-∞" : `${(20 * Math.log10(v)).toFixed(1)}`);

let uidCounter = 0;
export const uid = (prefix = "id") =>
  `${prefix}_${Date.now().toString(36)}_${(uidCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
