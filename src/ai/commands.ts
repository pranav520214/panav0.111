/* Command executor — the ONLY place project state is mutated.
 * Both user gestures and the AI copilot emit DawCommands; every batch
 * goes through here and is snapshot into the shared undo stack. */

import {
  Clip, DawCommand, Note, Placement, Project, STEPS_PER_BAR, Track, uid,
} from "../types";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function updateTrack(p: Project, trackId: string, fn: (t: Track) => Track): Project {
  if (!p.tracks.some((t) => t.id === trackId)) return p;
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
}

function updateClip(p: Project, clipId: string, fn: (c: Clip) => Clip): Project {
  const clip = p.clips[clipId];
  if (!clip) return p;
  return { ...p, clips: { ...p.clips, [clipId]: fn(clip) } };
}

export function execCommand(p: Project, c: DawCommand): Project {
  switch (c.op) {
    case "set_project_name":
      return { ...p, name: c.name.slice(0, 48) || p.name };

    case "set_tempo":
      return { ...p, bpm: Math.round(clamp(c.bpm, 55, 200)) };

    case "set_key":
      return { ...p, rootMidi: clamp(Math.round(c.rootMidi), 36, 84), scale: c.scale };

    case "set_length": {
      const bars = clamp(Math.round(c.bars), 1, 64);
      let next = { ...p, lengthBars: bars };
      // drop placements that now fall outside the timeline
      next = {
        ...next,
        tracks: next.tracks.map((t) => ({ ...t, placements: t.placements.filter((pl) => pl.bar < bars) })),
      };
      return next;
    }

    case "set_track_volume":
      return updateTrack(p, c.trackId, (t) => ({ ...t, volume: clamp(c.value, 0, 1.25) }));

    case "set_track_pan":
      return updateTrack(p, c.trackId, (t) => ({ ...t, pan: clamp(c.value, -1, 1) }));

    case "set_track_mute":
      return updateTrack(p, c.trackId, (t) => ({ ...t, mute: c.value }));

    case "set_track_solo":
      return updateTrack(p, c.trackId, (t) => ({ ...t, solo: c.value }));

    case "set_track_fx":
      return updateTrack(p, c.trackId, (t) => ({
        ...t,
        fx: {
          reverb: clamp(c.fx.reverb ?? t.fx.reverb, 0, 1),
          delay: clamp(c.fx.delay ?? t.fx.delay, 0, 1),
          cutoff: clamp(c.fx.cutoff ?? t.fx.cutoff, 300, 18000),
          drive: clamp(c.fx.drive ?? t.fx.drive, 0, 1),
        },
      }));

    case "rename_track":
      return updateTrack(p, c.trackId, (t) => ({ ...t, name: c.name.slice(0, 24) || t.name }));

    case "add_track":
      if (p.tracks.some((t) => t.id === c.track.id)) return p;
      return { ...p, tracks: [...p.tracks, c.track] };

    case "remove_track": {
      const track = p.tracks.find((t) => t.id === c.trackId);
      if (!track || p.tracks.length <= 1) return p;
      const usedElsewhere = new Set<string>();
      for (const t of p.tracks) if (t.id !== c.trackId) t.clipIds.forEach((id) => usedElsewhere.add(id));
      const clips = { ...p.clips };
      for (const id of track.clipIds) if (!usedElsewhere.has(id)) delete clips[id];
      return { ...p, tracks: p.tracks.filter((t) => t.id !== c.trackId), clips };
    }

    case "create_clip": {
      const track = p.tracks.find((t) => t.id === c.trackId);
      if (!track) return p;
      let next: Project = { ...p, clips: { ...p.clips, [c.clip.id]: c.clip } };
      next = updateTrack(next, c.trackId, (t) => ({
        ...t,
        clipIds: t.clipIds.includes(c.clip.id) ? t.clipIds : [...t.clipIds, c.clip.id],
        sourceClipId: c.makeSource === false ? t.sourceClipId : c.clip.id,
        placements: [
          ...t.placements.filter((pl) => !(c.placeBars ?? []).includes(pl.bar)),
          ...(c.placeBars ?? []).map((bar): Placement => ({ id: uid("pl"), clipId: c.clip.id, bar })),
        ],
      }));
      return next;
    }

    case "delete_clip": {
      const track = p.tracks.find((t) => t.id === c.trackId);
      if (!track || track.clipIds.length <= 1) return p;
      const clips = { ...p.clips };
      delete clips[c.clipId];
      return updateTrack({ ...p, clips }, c.trackId, (t) => {
        const clipIds = t.clipIds.filter((id) => id !== c.clipId);
        return {
          ...t,
          clipIds,
          sourceClipId: t.sourceClipId === c.clipId ? clipIds[0] : t.sourceClipId,
          placements: t.placements.filter((pl) => pl.clipId !== c.clipId),
        };
      });
    }

    case "set_clip_content":
      return updateClip(p, c.clipId, (clip) => ({
        ...clip,
        name: c.name ?? clip.name,
        lengthBars: c.lengthBars ? clamp(Math.round(c.lengthBars), 1, 8) : clip.lengthBars,
        notes: c.notes,
      }));

    case "add_notes":
      return updateClip(p, c.clipId, (clip) => ({ ...clip, notes: [...clip.notes, ...c.notes] }));

    case "transpose_clip":
      return updateClip(p, c.clipId, (clip) => ({
        ...clip,
        notes: clip.notes.map((n): Note => ({ ...n, pitch: n.pitch + c.semitones })),
      }));

    case "place_clip": {
      const track = p.tracks.find((t) => t.id === c.trackId);
      const clip = p.clips[c.clipId];
      if (!track || !clip || c.bar < 0 || c.bar >= p.lengthBars) return p;
      if (track.clipIds.includes(c.clipId) === false) return p;
      return updateTrack(p, c.trackId, (t) => ({
        ...t,
        placements: [
          ...t.placements.filter((pl) => pl.bar !== c.bar),
          { id: uid("pl"), clipId: c.clipId, bar: c.bar },
        ],
      }));
    }

    case "remove_placement":
      return updateTrack(p, c.trackId, (t) => ({
        ...t,
        placements: t.placements.filter((pl) => pl.id !== c.placementId),
      }));

    case "clear_placements":
      return {
        ...p,
        tracks: p.tracks.map((t) => {
          if (c.trackId && t.id !== c.trackId) return t;
          return {
            ...t,
            placements: t.placements.filter((pl) => {
              if (c.range) return pl.bar < c.range[0] || pl.bar >= c.range[1];
              return false;
            }),
          };
        }),
      };

    default:
      return p;
  }
}

export function execCommands(p: Project, commands: DawCommand[]): Project {
  return commands.reduce((acc, c) => {
    try {
      return execCommand(acc, c);
    } catch (err) {
      console.error("[cadence] command failed", c, err);
      return acc;
    }
  }, p);
}

/* ---------------- factories used by UI + AI ---------------- */

export function makeClip(name: string, lengthBars = 1, notes: Note[] = []): Clip {
  return { id: uid("clip"), name, lengthBars, notes };
}

export function makeTrack(kind: Project["tracks"][number]["instrument"], name: string, color: string): Track {
  const clip = makeClip(`${name} 1`);
  return {
    id: uid("trk"),
    name,
    color,
    instrument: kind,
    volume: kind === "drumkit" ? 0.95 : kind === "bass" ? 0.85 : 0.75,
    pan: 0,
    mute: false,
    solo: false,
    fx: {
      reverb: kind === "pad" ? 0.45 : kind === "pluck" ? 0.2 : 0.08,
      delay: kind === "pluck" ? 0.22 : 0,
      cutoff: kind === "bass" ? 4200 : kind === "pad" ? 7500 : 18000,
      drive: 0,
    },
    clipIds: [clip.id],
    sourceClipId: clip.id,
    placements: [],
  };
}

/** Track factory that also surfaces the starter clip for the clips map. */
export function makeTrackWithClip(kind: Project["tracks"][number]["instrument"], name: string, color: string): { track: Track; clip: Clip } {
  const clip = makeClip(`${name} 1`);
  const track = makeTrack(kind, name, color);
  track.clipIds = [clip.id];
  track.sourceClipId = clip.id;
  return { track, clip };
}

export function noteOf(pitch: number, start: number, dur: number, vel: number): Note {
  return { id: uid("n"), pitch, start, dur, vel };
}

export function clipWith(notes: Note[], name: string, lengthBars = 1): Clip {
  return { id: uid("clip"), name, lengthBars, notes };
}

export { STEPS_PER_BAR };
