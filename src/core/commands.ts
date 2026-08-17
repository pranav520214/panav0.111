/* Command vocabulary — the discrete, named operations that mutate a Project.
 *
 * Rules of the house:
 *  - A Command is a plain, serializable object with an `op` discriminant.
 *  - Commands never execute themselves; the bus validates them and hands them
 *    to the pure executors (src/core/executors.ts).
 *  - User gestures, the AI copilot and file imports all speak this same
 *    vocabulary — there is exactly one mutation path. */

import { Clip, Note, ScaleType, Track, TrackFx } from "../types";

export type Command =
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

export type CommandCategory = "structure" | "mix" | "midi";

/** Human-readable metadata per op — used by inspectors/logs and future tooling. */
export const COMMAND_META: Record<Command["op"], { name: string; category: CommandCategory }> = {
  set_project_name: { name: "Rename project", category: "structure" },
  set_tempo: { name: "Set tempo", category: "structure" },
  set_key: { name: "Set key", category: "structure" },
  set_length: { name: "Resize timeline", category: "structure" },
  set_track_volume: { name: "Set track volume", category: "mix" },
  set_track_pan: { name: "Set track pan", category: "mix" },
  set_track_mute: { name: "Toggle mute", category: "mix" },
  set_track_solo: { name: "Toggle solo", category: "mix" },
  set_track_fx: { name: "Adjust track FX", category: "mix" },
  rename_track: { name: "Rename track", category: "structure" },
  add_track: { name: "Add track", category: "structure" },
  remove_track: { name: "Remove track", category: "structure" },
  create_clip: { name: "Create clip", category: "midi" },
  delete_clip: { name: "Delete clip", category: "midi" },
  set_clip_content: { name: "Edit clip notes", category: "midi" },
  add_notes: { name: "Add notes", category: "midi" },
  transpose_clip: { name: "Transpose clip", category: "midi" },
  place_clip: { name: "Place clip on timeline", category: "midi" },
  remove_placement: { name: "Remove clip block", category: "midi" },
  clear_placements: { name: "Clear timeline blocks", category: "midi" },
};

/* ---------------- schema validation ----------------
 * The bus rejects any command that fails this check — atomically, before a
 * single executor runs. Executors additionally clamp values, so validation is
 * a coarse gate (types, enums, sane bounds) rather than a duplicate of the
 * executor's fine-grained clamps. */

const isStr = (v: unknown, max = 512): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const inRange = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
const isInt = (v: number) => Number.isInteger(v);

const INSTRUMENTS: readonly string[] = ["drumkit", "bass", "keys", "pluck", "pad"];

function checkNotes(notes: unknown): string | null {
  if (!Array.isArray(notes)) return "notes must be an array";
  if (notes.length > 8192) return "too many notes in one command (> 8192)";
  for (const n of notes) {
    if (typeof n !== "object" || n === null) return "note must be an object";
    const note = n as Record<string, unknown>;
    if (!isStr(note.id, 128)) return "note.id must be a non-empty string";
    if (!isNum(note.pitch) || !isInt(note.pitch) || !inRange(note.pitch, 0, 127)) return "note.pitch must be an integer 0–127";
    if (!isNum(note.start) || !isInt(note.start) || !inRange(note.start, 0, 4096)) return "note.start must be an integer 0–4096";
    if (!isNum(note.dur) || !isInt(note.dur) || !inRange(note.dur, 1, 256)) return "note.dur must be an integer 1–256";
    if (!isNum(note.vel) || !inRange(note.vel, 0, 1)) return "note.vel must be a number 0–1";
  }
  return null;
}

function checkClipShape(clip: unknown): string | null {
  if (typeof clip !== "object" || clip === null) return "clip must be an object";
  const c = clip as Record<string, unknown>;
  if (!isStr(c.id, 128)) return "clip.id must be a non-empty string";
  if (!isStr(c.name, 64)) return "clip.name must be a non-empty string";
  if (!isNum(c.lengthBars) || !isInt(c.lengthBars) || !inRange(c.lengthBars, 1, 64)) return "clip.lengthBars must be an integer 1–64";
  return checkNotes(c.notes);
}

/** Returns an error message, or null when the command is well-formed. */
export function validateCommand(c: Command): string | null {
  if (typeof c !== "object" || c === null || typeof (c as { op?: unknown }).op !== "string") {
    return "command must be an object with an op";
  }
  switch (c.op) {
    case "set_project_name":
      return isStr(c.name, 64) ? null : "name must be a non-empty string (≤ 64 chars)";
    case "set_tempo":
      return isNum(c.bpm) && inRange(c.bpm, 30, 300) ? null : "bpm must be a number 30–300";
    case "set_key":
      if (!isNum(c.rootMidi) || !isInt(c.rootMidi) || !inRange(c.rootMidi, 24, 108)) return "rootMidi must be an integer 24–108";
      return c.scale === "minor" || c.scale === "major" ? null : "scale must be 'minor' or 'major'";
    case "set_length":
      return isNum(c.bars) && isInt(c.bars) && inRange(c.bars, 1, 512) ? null : "bars must be an integer 1–512";
    case "set_track_volume":
      if (!isStr(c.trackId, 128)) return "trackId must be a non-empty string";
      return isNum(c.value) && inRange(c.value, 0, 2) ? null : "value must be a number 0–2";
    case "set_track_pan":
      if (!isStr(c.trackId, 128)) return "trackId must be a non-empty string";
      return isNum(c.value) && inRange(c.value, -1, 1) ? null : "value must be a number -1–1";
    case "set_track_mute":
    case "set_track_solo":
      if (!isStr(c.trackId, 128)) return "trackId must be a non-empty string";
      return isBool(c.value) ? null : "value must be a boolean";
    case "set_track_fx": {
      if (!isStr(c.trackId, 128)) return "trackId must be a non-empty string";
      if (typeof c.fx !== "object" || c.fx === null) return "fx must be an object";
      const fx = c.fx as Record<string, unknown>;
      const bounds: [keyof TrackFx, number, number][] = [
        ["reverb", 0, 1], ["delay", 0, 1], ["cutoff", 50, 20000], ["drive", 0, 1],
      ];
      for (const [key, lo, hi] of bounds) {
        const v = fx[key];
        if (v !== undefined && (!isNum(v) || !inRange(v, lo, hi))) return `fx.${key} must be a number ${lo}–${hi}`;
      }
      return null;
    }
    case "rename_track":
      if (!isStr(c.trackId, 128)) return "trackId must be a non-empty string";
      return isStr(c.name, 40) ? null : "name must be a non-empty string (≤ 40 chars)";
    case "add_track": {
      const t = c.track as unknown as Record<string, unknown>;
      if (typeof t !== "object" || t === null) return "track must be an object";
      if (!isStr(t.id, 128)) return "track.id must be a non-empty string";
      if (!isStr(t.name, 40)) return "track.name must be a non-empty string";
      if (typeof t.instrument !== "string" || !INSTRUMENTS.includes(t.instrument)) return "track.instrument is not a known instrument";
      if (!isNum(t.volume) || !inRange(t.volume, 0, 2)) return "track.volume must be a number 0–2";
      if (!isNum(t.pan) || !inRange(t.pan, -1, 1)) return "track.pan must be a number -1–1";
      if (!Array.isArray(t.clipIds)) return "track.clipIds must be an array";
      return null;
    }
    case "remove_track":
      return isStr(c.trackId, 128) ? null : "trackId must be a non-empty string";
    case "create_clip": {
      if (!isStr(c.trackId, 128)) return "trackId must be a non-empty string";
      const clipErr = checkClipShape(c.clip);
      if (clipErr) return clipErr;
      if (c.placeBars !== undefined) {
        if (!Array.isArray(c.placeBars) || c.placeBars.length > 512) return "placeBars must be an array (≤ 512)";
        for (const b of c.placeBars) if (!isNum(b) || !isInt(b) || !inRange(b, 0, 4096)) return "placeBars entries must be integers 0–4096";
      }
      if (c.makeSource !== undefined && !isBool(c.makeSource)) return "makeSource must be a boolean";
      return null;
    }
    case "delete_clip":
      if (!isStr(c.trackId, 128)) return "trackId must be a non-empty string";
      return isStr(c.clipId, 128) ? null : "clipId must be a non-empty string";
    case "set_clip_content": {
      if (!isStr(c.clipId, 128)) return "clipId must be a non-empty string";
      const notesErr = checkNotes(c.notes);
      if (notesErr) return notesErr;
      if (c.lengthBars !== undefined && (!isNum(c.lengthBars) || !isInt(c.lengthBars) || !inRange(c.lengthBars, 1, 64))) {
        return "lengthBars must be an integer 1–64";
      }
      if (c.name !== undefined && !isStr(c.name, 64)) return "name must be a non-empty string (≤ 64 chars)";
      return null;
    }
    case "add_notes": {
      if (!isStr(c.clipId, 128)) return "clipId must be a non-empty string";
      return checkNotes(c.notes);
    }
    case "transpose_clip":
      if (!isStr(c.clipId, 128)) return "clipId must be a non-empty string";
      return isNum(c.semitones) && isInt(c.semitones) && inRange(c.semitones, -48, 48)
        ? null
        : "semitones must be an integer -48–48";
    case "place_clip":
      if (!isStr(c.trackId, 128)) return "trackId must be a non-empty string";
      if (!isStr(c.clipId, 128)) return "clipId must be a non-empty string";
      return isNum(c.bar) && isInt(c.bar) && inRange(c.bar, 0, 4096) ? null : "bar must be an integer 0–4096";
    case "remove_placement":
      if (!isStr(c.trackId, 128)) return "trackId must be a non-empty string";
      return isStr(c.placementId, 128) ? null : "placementId must be a non-empty string";
    case "clear_placements": {
      if (c.trackId !== undefined && !isStr(c.trackId, 128)) return "trackId must be a non-empty string";
      if (c.range !== undefined) {
        if (!Array.isArray(c.range) || c.range.length !== 2) return "range must be a [start, end] pair";
        for (const b of c.range) if (!isNum(b) || !isInt(b) || !inRange(b, 0, 4096)) return "range entries must be integers 0–4096";
      }
      return null;
    }
    default:
      return "unknown command op";
  }
}
