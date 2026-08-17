/* Cadence — core domain model.
 * Everything the engine, the UI and the AI command system share. */

export type Mode = "beginner" | "producer" | "advanced";
export type ScaleType = "minor" | "major";
export type InstrumentKind = "drumkit" | "bass" | "keys" | "pluck" | "pad";

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

export interface Project {
  name: string;
  bpm: number;
  rootMidi: number;
  scale: ScaleType;
  lengthBars: number;
  tracks: Track[];
  clips: Record<string, Clip>;
}

/* ---------------- AI command system ----------------
 * The AI never touches state directly. It emits DawCommands,
 * which are validated and executed by the command executor,
 * and every batch is undoable through the shared undo stack. */

export type DawCommand =
  | { op: "set_project_name"; name: string }
  | { op: "set_tempo"; bpm: number }
  | { op: "set_key"; rootMidi: number; scale: ScaleType }
  | { op: "set_length"; bars: number }
  | { op: "set_track_volume"; trackId: string; value: number }
  | { op: "set_track_pan"; trackId: string; value: number }
  | { op: "set_track_mute"; trackId: string; value: boolean }
  | { op: "set_track_solo"; trackId: string; value: boolean }
  | { op: "set_track_fx"; trackId: string; fx: Partial<TrackFx> }
  | { op: "rename_track"; trackId: string; name: string }
  | { op: "add_track"; track: Track }
  | { op: "remove_track"; trackId: string }
  | { op: "create_clip"; trackId: string; clip: Clip; placeBars?: number[]; makeSource?: boolean }
  | { op: "delete_clip"; trackId: string; clipId: string }
  | { op: "set_clip_content"; clipId: string; notes: Note[]; lengthBars?: number; name?: string }
  | { op: "add_notes"; clipId: string; notes: Note[] }
  | { op: "transpose_clip"; clipId: string; semitones: number }
  | { op: "place_clip"; trackId: string; clipId: string; bar: number }
  | { op: "remove_placement"; trackId: string; placementId: string }
  | { op: "clear_placements"; trackId?: string; range?: [number, number] };

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
