/* Project file validation & sanitization.
 *
 * Security rule: EVERY project that enters the app — autosave restore,
 * file import, bus.replace() — passes through validateProject().
 * We never trust parsed JSON: the validator rebuilds a sanitized Project
 * from scratch, clamping ranges, allow-listing enums and capping sizes,
 * so a tampered or version-skewed save can never crash the engine or the UI. */

import {
  AutomationLane, AutomationParam, Clip, InstrumentKind, LoopRegion, Marker, Note,
  Placement, Project, ScaleType, TimeSignature, Track, uid,
} from "../types";

const AUTOMATION_PARAMS = new Set<string>(["volume", "pan", "reverb", "delay", "cutoff", "drive"]);
const TIME_SIG_UNITS = new Set<number>([2, 4, 8, 16]);

export type ValidationResult =
  | { ok: true; project: Project }
  | { ok: false; error: string };

const INSTRUMENTS = new Set<string>(["drumkit", "bass", "keys", "pluck", "pad"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const num = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
};
const int = (v: unknown, min: number, max: number, fallback: number): number =>
  Math.round(num(v, min, max, fallback));
const str = (v: unknown, max: number, fallback: string): string =>
  typeof v === "string" ? v.slice(0, max) : fallback;
const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;
const id = (v: unknown, prefix: string): string =>
  typeof v === "string" && ID_RE.test(v) ? v : uid(prefix);

const MAX_TRACKS = 24;
const MAX_CLIPS = 512;
const MAX_NOTES = 2048;
const MAX_PLACEMENTS = 256;

function validateNote(raw: unknown): Note | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = raw as Record<string, unknown>;
  return {
    id: id(n.id, "n"),
    // wide range here; per-track clamping below tightens drums (0–4) vs melodic (21–108)
    pitch: int(n.pitch, 0, 127, 57),
    start: int(n.start, 0, 16 * 64, 0),
    dur: int(n.dur, 1, 64, 1),
    vel: num(n.vel, 0.05, 1, 0.8),
  };
}

function validateClip(raw: unknown, limitBars: number): Clip | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const lengthBars = int(c.lengthBars, 1, limitBars, 1);
  const notes = Array.isArray(c.notes)
    ? c.notes.slice(0, MAX_NOTES).map((n) => validateNote(n)).filter((n): n is Note => n !== null)
    : [];
  return {
    id: id(c.id, "clip"),
    name: str(c.name, 40, "Clip"),
    lengthBars,
    notes,
  };
}

export function validateProject(raw: unknown): ValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Not a project object" };
  }
  const p = raw as Record<string, unknown>;

  const lengthBars = int(p.lengthBars, 4, 64, 8);
  const scale: ScaleType = p.scale === "major" ? "major" : "minor";

  /* clips first — tracks reference them */
  const clips: Record<string, Clip> = {};
  if (typeof p.clips === "object" && p.clips !== null && !Array.isArray(p.clips)) {
    let i = 0;
    for (const [k, v] of Object.entries(p.clips as Record<string, unknown>)) {
      if (i++ >= MAX_CLIPS) break;
      const clip = validateClip(v, 32);
      if (clip) clips[ID_RE.test(k) ? k : clip.id] = clip;
    }
  }

  const tracks: Track[] = [];
  if (Array.isArray(p.tracks)) {
    for (const rt of p.tracks.slice(0, MAX_TRACKS)) {
      if (typeof rt !== "object" || rt === null) continue;
      const t = rt as Record<string, unknown>;
      const instrument = INSTRUMENTS.has(String(t.instrument)) ? (String(t.instrument) as InstrumentKind) : "keys";
      const drum = instrument === "drumkit";

      const clipIds = Array.isArray(t.clipIds)
        ? t.clipIds.filter((c): c is string => typeof c === "string" && clips[c] !== undefined).slice(0, 64)
        : [];
      let sourceClipId = typeof t.sourceClipId === "string" && clips[t.sourceClipId] ? t.sourceClipId : "";
      if (!sourceClipId) {
        if (clipIds.length > 0) sourceClipId = clipIds[0];
        else {
          const c: Clip = { id: uid("clip"), name: "Starter", lengthBars: 1, notes: [] };
          clips[c.id] = c;
          clipIds.push(c.id);
          sourceClipId = c.id;
        }
      }

      const placements: Placement[] = [];
      if (Array.isArray(t.placements)) {
        for (const rp of t.placements.slice(0, MAX_PLACEMENTS)) {
          if (typeof rp !== "object" || rp === null) continue;
          const pl = rp as Record<string, unknown>;
          const clipId = typeof pl.clipId === "string" && clips[pl.clipId] ? pl.clipId : "";
          if (!clipId) continue;
          // bars may be fractional (beat-level splits); snap to the nearest 1/16
          const bar = Math.round(num(pl.bar, 0, lengthBars, 0) * 16) / 16;
          const clipLen = clips[clipId].lengthBars;
          const offsetSteps = Math.round(num(pl.offsetSteps, 0, clipLen * 16, 0));
          const plOut: Placement = { id: id(pl.id, "pl"), clipId, bar };
          if (offsetSteps > 0) plOut.offsetSteps = offsetSteps;
          if (pl.lengthBars !== undefined) {
            // audible length: at least 1 step, never past the clip's tail
            const maxLen = clipLen - offsetSteps / 16;
            plOut.lengthBars = Math.min(maxLen, Math.max(1 / 16, num(pl.lengthBars, 0, 64, maxLen)));
          }
          const fi = Math.round(num(pl.fadeIn, 0, 256, 0));
          const fo = Math.round(num(pl.fadeOut, 0, 256, 0));
          if (fi > 0) plOut.fadeIn = fi;
          if (fo > 0) plOut.fadeOut = fo;
          placements.push(plOut);
        }
      }

      const fxRaw = (typeof t.fx === "object" && t.fx !== null ? t.fx : {}) as Record<string, unknown>;

      tracks.push({
        id: id(t.id, "trk"),
        name: str(t.name, 32, "Track") || "Track",
        color: typeof t.color === "string" && COLOR_RE.test(t.color) ? t.color : "#58b7f5",
        instrument,
        volume: num(t.volume, 0, 1.25, 0.8),
        pan: num(t.pan, -1, 1, 0),
        mute: bool(t.mute, false),
        solo: bool(t.solo, false),
        fx: {
          reverb: num(fxRaw.reverb, 0, 1, 0.1),
          delay: num(fxRaw.delay, 0, 1, 0),
          cutoff: num(fxRaw.cutoff, 200, 18000, 12000),
          drive: num(fxRaw.drive, 0, 1, 0),
        },
        clipIds,
        sourceClipId,
        placements,
        groupId: typeof t.groupId === "string" && t.groupId.length <= 16 ? t.groupId : null,
      });

      // note ranges must match the instrument even if the clip pre-dated a track swap
      for (const cid of clipIds) {
        for (const n of clips[cid].notes) {
          n.pitch = drum ? Math.min(4, Math.max(0, n.pitch)) : Math.min(108, Math.max(21, n.pitch));
        }
      }
    }
  }

  if (tracks.length === 0) {
    return { ok: false, error: "Project contains no usable tracks" };
  }

  /* time signature — carried by the file format; the timeline currently
   * renders 4/4 grids, so anything else is preserved but noted as inert */
  const tsRaw = (typeof p.timeSignature === "object" && p.timeSignature !== null ? p.timeSignature : {}) as Record<string, unknown>;
  const timeSignature: TimeSignature = {
    numerator: int(tsRaw.numerator, 2, 16, 4),
    denominator: TIME_SIG_UNITS.has(Number(tsRaw.denominator)) ? Number(tsRaw.denominator) : 4,
  };

  /* automation lanes — preserved end-to-end; ids/params allow-listed,
   * points capped so a hostile file can't balloon memory */
  const trackIds = new Set(tracks.map((t) => t.id));
  const automation: AutomationLane[] = [];
  if (Array.isArray(p.automation)) {
    for (const ra of p.automation.slice(0, 64)) {
      if (typeof ra !== "object" || ra === null) continue;
      const a = ra as Record<string, unknown>;
      const trackId = typeof a.trackId === "string" && trackIds.has(a.trackId) ? a.trackId : "";
      const param = typeof a.param === "string" && AUTOMATION_PARAMS.has(a.param) ? (a.param as AutomationParam) : null;
      if (!trackId || !param) continue;
      const points = Array.isArray(a.points)
        ? a.points.slice(0, 512).flatMap((rp): { step: number; value: number }[] => {
            if (typeof rp !== "object" || rp === null) return [];
            const pt = rp as Record<string, unknown>;
            if (typeof pt.step !== "number" || typeof pt.value !== "number") return [];
            return [{ step: int(pt.step, 0, 16 * 64, 0), value: num(pt.value, 0, 1, 0) }];
          })
        : [];
      automation.push({ id: id(a.id, "auto"), trackId, param, points });
    }
  }

  /* markers — capped, ids/labels sanitized, bars clamped to the timeline */
  const markers: Marker[] = [];
  if (Array.isArray(p.markers)) {
    for (const rm of p.markers.slice(0, 64)) {
      if (typeof rm !== "object" || rm === null) continue;
      const m = rm as Record<string, unknown>;
      markers.push({
        id: id(m.id, "mk"),
        bar: Math.round(num(m.bar, 0, lengthBars, 0) * 16) / 16,
        label: str(m.label, 24, "Marker") || "Marker",
      });
    }
    markers.sort((a, b) => a.bar - b.bar);
  }

  /* loop region — null unless it's a sane, ordered pair inside the timeline */
  let loopRegion: LoopRegion | null = null;
  if (typeof p.loopRegion === "object" && p.loopRegion !== null) {
    const lr = p.loopRegion as Record<string, unknown>;
    const startBar = num(lr.startBar, 0, lengthBars, 0);
    const endBar = num(lr.endBar, 0, lengthBars, 0);
    if (endBar - startBar >= 0.25) loopRegion = { startBar, endBar };
  }

  const now = Date.now();

  return {
    ok: true,
    project: {
      name: str(p.name, 60, "Untitled Session") || "Untitled Session",
      bpm: num(p.bpm, 55, 200, 110),
      rootMidi: int(p.rootMidi, 36, 84, 57),
      scale,
      lengthBars,
      timeSignature,
      automation,
      tracks,
      clips,
      markers,
      loopRegion,
      createdAt: typeof p.createdAt === "number" && Number.isFinite(p.createdAt) && p.createdAt >= 0 ? p.createdAt : now,
      modifiedAt: typeof p.modifiedAt === "number" && Number.isFinite(p.modifiedAt) && p.modifiedAt >= 0 ? p.modifiedAt : now,
    },
  };
}

/* File parsing lives in src/core/format.ts (versioned envelope + migrations).
 * validateProject() above is the shared sanitizer that both the format layer
 * and the autosave restore path apply to untrusted data. */
