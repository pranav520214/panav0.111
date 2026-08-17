/* Cadence Copilot — the AI layer.
 * Philosophy: never touch state directly. Parse intent → emit DawCommands →
 * the user approves plans → the shared executor applies them → undoable.
 * Deterministic generators are used instead of heavyweight inference, so the
 * copilot costs ~0 CPU/GPU when idle and stays instant on low-spec machines. */

import {
  Clip, DawCommand, InstrumentKind, Note, Project, Track, dbLabel, uid,
} from "../types";
import {
  SCALES, genBass, genChords, genDrums, genMelody, mulberry32, padFromChords, Rng,
} from "../theory";

export interface PlanItem { label: string; command: DawCommand; }
export type AiResult =
  | { kind: "reply"; text: string }
  | { kind: "run"; text: string; commands: DawCommand[] }
  | { kind: "plan"; title: string; summary: string; items: PlanItem[] };

/* ---------------- helpers ---------------- */

const INSTRUMENT_WORD: Record<string, InstrumentKind> = {
  drum: "drumkit", drums: "drumkit", kit: "drumkit", beat: "drumkit", percussion: "drumkit",
  kick: "drumkit", snare: "drumkit", hat: "drumkit", hats: "drumkit", clap: "drumkit",
  bass: "bass", sub: "bass",
  keys: "keys", chord: "keys", chords: "keys", piano: "keys", keyboard: "keys",
  lead: "pluck", pluck: "pluck", melody: "pluck", hook: "pluck",
  pad: "pad", atmosphere: "pad", ambient: "pad",
};

function findTrack(p: Project, text: string): Track | null {
  for (const t of p.tracks) {
    if (text.includes(t.name.toLowerCase())) return t;
  }
  for (const [word, kind] of Object.entries(INSTRUMENT_WORD)) {
    if (new RegExp(`\\b${word}`).test(text)) {
      const t = p.tracks.find((tr) => tr.instrument === kind);
      if (t) return t;
    }
  }
  return null;
}

const findKind = (p: Project, kind: InstrumentKind) => p.tracks.find((t) => t.instrument === kind) ?? null;

const rngNow = (): Rng => mulberry32((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);

const dbToLin = (db: number) => Math.pow(10, db / 20);
const linToDb = (v: number) => (v <= 0.0001 ? -60 : 20 * Math.log10(v));

function drumEnergy(clip: Clip | undefined): number {
  if (!clip || clip.notes.length === 0) return 0;
  const perBar = clip.notes.length / clip.lengthBars;
  return perBar > 26 ? 2 : perBar > 14 ? 1 : 0;
}

function ensureTrack(p: Project, kind: InstrumentKind, items: PlanItem[], clipsToCreate: Clip[], name: string, color: string): Track {
  const existing = findKind(p, kind);
  if (existing) return existing;
  const clip: Clip = { id: uid("clip"), name: `${name} 1`, lengthBars: 1, notes: [] };
  clipsToCreate.push(clip);
  const track: Track = {
    id: uid("trk"), name, color, instrument: kind,
    volume: 0.8, pan: 0, mute: false, solo: false,
    fx: { reverb: kind === "pad" ? 0.4 : 0.1, delay: 0, cutoff: kind === "bass" ? 4200 : 12000, drive: 0 },
    clipIds: [clip.id], sourceClipId: clip.id, placements: [],
  };
  items.push({ label: `Add a new ${name} track`, command: { op: "add_track", track } });
  return track;
}

function emptyBars(p: Project, track: Track | null): number[] {
  const used = new Set((track?.placements ?? []).map((pl) => pl.bar));
  const bars: number[] = [];
  for (let b = 0; b < p.lengthBars; b++) if (!used.has(b)) bars.push(b);
  return bars;
}

/* ---------------- the parser ---------------- */

export function aiRespond(raw: string, p: Project): AiResult {
  const text = raw.toLowerCase().trim();
  const rng = rngNow();

  /* -- questions & learning -- */
  if (/(what|how|why|explain|define|tell me about|help me understand)\b/.test(text) || text.endsWith("?")) {
    const gloss = glossary(text);
    if (gloss) return { kind: "reply", text: gloss };
  }
  if (/\b(help|what can you do|commands)\b/.test(text) && text.length < 40) {
    return { kind: "reply", text: CAPABILITIES };
  }

  /* -- tempo -- */
  const bpmMatch = text.match(/(?:tempo|bpm|speed)\D{0,8}(\d{2,3})/) ?? text.match(/(\d{2,3})\s*bpm/);
  if (bpmMatch) {
    const bpm = Math.max(55, Math.min(200, parseInt(bpmMatch[1], 10)));
    return {
      kind: "run",
      text: `Setting the project tempo to ${bpm} BPM.`,
      commands: [{ op: "set_tempo", bpm }],
    };
  }
  if (/(faster|speed up)/.test(text)) return { kind: "run", text: `Nudging the tempo up to ${Math.min(200, p.bpm + 6)} BPM.`, commands: [{ op: "set_tempo", bpm: p.bpm + 6 }] };
  if (/(slower|slow down)/.test(text)) return { kind: "run", text: `Easing the tempo down to ${Math.max(55, p.bpm - 6)} BPM.`, commands: [{ op: "set_tempo", bpm: p.bpm - 6 }] };

  /* -- volume / pan / mute / solo -- */
  const louder = /(louder|boost|turn .* up|more volume|bigger)/.test(text);
  const quieter = /(quieter|softer|turn .* down|less volume|lower)/.test(text);
  if (louder || quieter) {
    const t = findTrack(p, text) ?? p.tracks[0];
    const delta = louder ? 2.5 : -2.5;
    const next = dbToLin(Math.min(6, linToDb(t.volume) + delta));
    return {
      kind: "run",
      text: `${t.name}: ${dbLabel(t.volume)} dB → ${dbLabel(next)} dB. If it's not right, Ctrl+Z reverts it.`,
      commands: [{ op: "set_track_volume", trackId: t.id, value: next }],
    };
  }
  if (/pan/.test(text)) {
    const t = findTrack(p, text) ?? p.tracks[0];
    const val = /left/.test(text) ? -0.5 : /right/.test(text) ? 0.5 : 0;
    return { kind: "run", text: `Panning ${t.name} ${val < 0 ? "left" : val > 0 ? "right" : "center"}.`, commands: [{ op: "set_track_pan", trackId: t.id, value: val }] };
  }
  if (/unmute|mute off/.test(text) || /\bmute\b/.test(text)) {
    const t = findTrack(p, text);
    if (t) {
      const val = !/unmute|off/.test(text);
      return { kind: "run", text: `${val ? "Muting" : "Unmuting"} ${t.name}.`, commands: [{ op: "set_track_mute", trackId: t.id, value: val }] };
    }
  }
  if (/unsolo|solo off/.test(text)) {
    return { kind: "run", text: "All solos released — every audible track is back.", commands: p.tracks.filter((t) => t.solo).map((t) => ({ op: "set_track_solo" as const, trackId: t.id, value: false })) };
  }
  if (/\bsolo\b/.test(text)) {
    const t = findTrack(p, text);
    if (t) return { kind: "run", text: `Soloing ${t.name} — press S on the track (or ask me to unsolo) to bring the rest back.`, commands: [{ op: "set_track_solo", trackId: t.id, value: true }] };
  }

  /* -- transpose -- */
  const trMatch = text.match(/transpose\s+(\w+)?\s*(up|down)?\s*(\d+)?/);
  if (trMatch) {
    const t = findTrack(p, text) ?? findKind(p, "pluck") ?? p.tracks[0];
    const n = parseInt(trMatch[3] ?? "2", 10);
    const dir = trMatch[2] === "down" ? -1 : 1;
    const clip = p.clips[t.sourceClipId];
    if (clip && t.instrument !== "drumkit") {
      return { kind: "run", text: `Transposing ${clip.name} ${dir > 0 ? "up" : "down"} ${n} semitone${n > 1 ? "s" : ""}.`, commands: [{ op: "transpose_clip", clipId: clip.id, semitones: dir * n }] };
    }
  }

  /* -- arrangement -- */
  if (/(arrange|structure|full song|into a song|sections|intro.*chorus|verse)/.test(text)) {
    return arrangePlan(p, rng);
  }

  /* -- energy shaping -- */
  if (/(more energy|energetic|punchier|hype|intense|bigger drop|exciting)/.test(text)) return energyPlan(p, rng, +1);
  if (/(chill|calm|relax|softer vibe|mellow|less energy|laid back|lofi|lo-fi)/.test(text)) return energyPlan(p, rng, -1);

  /* -- mixing -- */
  if (/(mix|balance|level|clean up|polish|master|masking)/.test(text)) return mixPlan(p);

  /* -- part generation -- */
  if (/(drum|beat|groove|percussion)\b/.test(text)) return partPlan(p, rng, "drumkit", text);
  if (/(bass(line)?)\b/.test(text)) return partPlan(p, rng, "bass", text);
  if (/(chord|harmony|keys|piano)\b/.test(text)) return partPlan(p, rng, "keys", text);
  if (/(melody|lead|hook|topline)\b/.test(text)) return partPlan(p, rng, "pluck", text);
  if (/(pad|atmosphere|texture|ambient)\b/.test(text)) return partPlan(p, rng, "pad", text);

  /* -- track management -- */
  if (/add (a |an )?track/.test(text)) {
    for (const [word, kind] of Object.entries(INSTRUMENT_WORD)) {
      if (text.includes(word)) {
        const names: Record<InstrumentKind, [string, string]> = {
          drumkit: ["Drums", "#ff6f61"], bass: ["Bass", "#f0a848"], keys: ["Keys", "#3ecfb2"],
          pluck: ["Lead", "#58b7f5"], pad: ["Pad", "#a78bfa"],
        };
        const items: PlanItem[] = [];
        const clips: Clip[] = [];
        const t = ensureTrack(p, kind, items, clips, names[kind][0], names[kind][1]);
        if (items.length === 0) return { kind: "reply", text: `You already have a ${names[kind][0]} track (${t.name}). Try "make a melody" or "add a pad".` };
        for (const c of clips) items.unshift({ label: `Create starter clip ${c.name}`, command: { op: "create_clip", trackId: t.id, clip: c } });
        return { kind: "plan", title: `Add ${names[kind][0]} track`, summary: "One new track with an empty starter clip, ready to paint onto the timeline.", items };
      }
    }
  }
  if (/(clear|empty) (the )?(clip|pattern|track)/.test(text)) {
    const t = findTrack(p, text) ?? p.tracks[0];
    const clip = p.clips[t.sourceClipId];
    if (clip) return { kind: "run", text: `Cleared ${clip.name} on ${t.name}. Undo brings it back.`, commands: [{ op: "set_clip_content", clipId: clip.id, notes: [] }] };
  }

  return {
    kind: "reply",
    text: `I didn't catch a command I know yet. I work best with production verbs — try one of the chips below, or things like "make the drums louder", "set tempo to 128", "add a melody", "make it more energetic", or "arrange my song".`,
  };
}

/* ---------------- plan builders ---------------- */

function partPlan(p: Project, rng: Rng, kind: InstrumentKind, text: string): AiResult {
  const items: PlanItem[] = [];
  const clipsToCreate: Clip[] = [];
  const names: Record<InstrumentKind, [string, string]> = {
    drumkit: ["Drums", "#ff6f61"], bass: ["Bass", "#f0a848"], keys: ["Keys", "#3ecfb2"],
    pluck: ["Lead", "#58b7f5"], pad: ["Pad", "#a78bfa"],
  };
  const track = ensureTrack(p, kind, items, clipsToCreate, names[kind][0], names[kind][1]);
  const energetic = /(energetic|dense|busy|full)/.test(text);
  const sparse = /(simple|sparse|minimal|basic)/.test(text);
  const energy = energetic ? 2 : sparse ? 0 : 1;

  const existingClip = p.clips[track.sourceClipId];
  let notes: Note[];
  let label: string;
  if (kind === "drumkit") { notes = genDrums(rng, energy, 1); label = `Write a ${["minimal", "grooving", "dense"][energy]} drum pattern`; }
  else if (kind === "bass") { notes = genBass(rng, p.rootMidi, p.scale, 2, energy); label = `Compose a ${["root-note", "moving", "driving"][energy]} bassline (2 bars)`; }
  else if (kind === "keys") { notes = genChords(rng, p.rootMidi, p.scale, 4, energy); label = `Voice a 4-bar chord progression in ${keyName(p)}`; }
  else if (kind === "pluck") { notes = genMelody(rng, p.rootMidi, p.scale, 2, energy); label = `Sketch a ${["sparse", "singable", "busy"][energy]} melody (2 bars)`; }
  else {
    const chords = genChords(rng, p.rootMidi, p.scale, 4, 0);
    notes = padFromChords(chords, p.rootMidi);
    label = "Sustain soft pad chords under the progression";
  }

  const clipId = existingClip ? existingClip.id : (clipsToCreate[0]?.id ?? uid("clip"));
  if (!existingClip && clipsToCreate.length > 0) {
    // ensureTrack already queued add_track; create the generated clip inside it
    clipsToCreate[0].notes = notes;
    clipsToCreate[0].lengthBars = kind === "keys" || kind === "pad" ? 4 : kind === "drumkit" ? 1 : 2;
  }
  if (existingClip) {
    items.push({
      label,
      command: { op: "set_clip_content", clipId, notes, lengthBars: kind === "keys" || kind === "pad" ? 4 : kind === "drumkit" ? 1 : 2 },
    });
  } else {
    items.push({ label, command: { op: "set_clip_content", clipId, notes, lengthBars: kind === "keys" || kind === "pad" ? 4 : kind === "drumkit" ? 1 : 2 } });
  }

  const bars = emptyBars(p, track);
  if (bars.length > 0) {
    const clipLen = kind === "keys" || kind === "pad" ? 4 : kind === "drumkit" ? 1 : 2;
    const chosen: number[] = [];
    for (const b of bars) {
      if (chosen.some((c) => Math.abs(b - c) < clipLen)) continue;
      chosen.push(b);
    }
    items.push({
      label: `Place it on the timeline (bars ${chosen.map((b) => b + 1).join(", ")})`,
      command: { op: "create_clip", trackId: track.id, clip: { id: clipId, name: existingClip?.name ?? `${track.name} 1`, lengthBars: clipLen, notes }, placeBars: chosen, makeSource: false },
    });
  }

  return {
    kind: "plan",
    title: `${names[kind][0]} ${kind === "drumkit" ? "beat" : "part"} for "${p.name}"`,
    summary: `Generated in ${keyName(p)} at ${p.bpm} BPM. Approve to apply — one Ctrl+Z reverts everything.`,
    items,
  };
}

function energyPlan(p: Project, rng: Rng, dir: 1 | -1): AiResult {
  const items: PlanItem[] = [];
  const up = dir === 1;
  const drums = findKind(p, "drumkit");
  const bass = findKind(p, "bass");
  const lead = findKind(p, "pluck");

  const newBpm = Math.max(60, Math.min(165, p.bpm + dir * 6));
  if (newBpm !== p.bpm) {
    items.push({ label: `Tempo ${p.bpm} → ${newBpm} BPM`, command: { op: "set_tempo", bpm: newBpm } });
  }

  if (drums) {
    const clip = p.clips[drums.sourceClipId];
    const e = Math.max(0, Math.min(2, drumEnergy(clip) + dir));
    items.push({
      label: `Rewrite drums at energy ${e + 1}/3 (${up ? "tighter kicks, busier hats" : "sparser, more space"})`,
      command: { op: "set_clip_content", clipId: drums.sourceClipId, notes: genDrums(rng, e, clip?.lengthBars ?? 1) },
    });
    items.push({
      label: `Drums ${up ? "+1.8 dB" : "−1.8 dB"}`,
      command: { op: "set_track_volume", trackId: drums.id, value: dbToLin(linToDb(drums.volume) + dir * 1.8) },
    });
    if (up) items.push({ label: "Add drive glue to the drum bus", command: { op: "set_track_fx", trackId: drums.id, fx: { drive: 0.18 } } });
  }

  if (bass) {
    items.push({
      label: up ? "Bass: octave jumps on the last 1/8 of each bar" : "Bass: long root notes only",
      command: { op: "set_clip_content", clipId: bass.sourceClipId, notes: genBass(rng, p.rootMidi, p.scale, p.clips[bass.sourceClipId]?.lengthBars ?? 2, up ? 2 : 0) },
    });
  }

  if (lead) {
    if (up) {
      items.push({ label: "Lead +1.5 dB and a touch of delay", command: { op: "set_track_volume", trackId: lead.id, value: dbToLin(linToDb(lead.volume) + 1.5) } });
      items.push({ label: "Delay send 25% on the lead", command: { op: "set_track_fx", trackId: lead.id, fx: { delay: 0.25 } } });
    } else {
      const pad = findKind(p, "pad");
      const keys = findKind(p, "keys");
      items.push({ label: "Soften the lead by −2 dB", command: { op: "set_track_volume", trackId: lead.id, value: dbToLin(linToDb(lead.volume) - 2) } });
      if (pad) items.push({ label: "Widen the pad reverb (60%)", command: { op: "set_track_fx", trackId: pad.id, fx: { reverb: 0.6 } } });
      if (keys) items.push({ label: "Airy reverb on keys (35%)", command: { op: "set_track_fx", trackId: keys.id, fx: { reverb: 0.35 } } });
    }
  }

  return {
    kind: "plan",
    title: up ? "Raise the energy" : "Bring it down a notch",
    summary: up
      ? "Density, loudness and motion go up — tempo, drum density, bass variation and lead presence. Fully undoable."
      : "Space and calm go up — slower tempo, sparser drums, softer lead, wider reverb. Fully undoable.",
    items,
  };
}

function mixPlan(p: Project): AiResult {
  const items: PlanItem[] = [];
  const findings: string[] = [];

  const targetVol: Partial<Record<InstrumentKind, number>> = {
    drumkit: 0.95, bass: 0.8, keys: 0.62, pluck: 0.72, pad: 0.52,
  };
  const targetPan: Partial<Record<InstrumentKind, number>> = {
    drumkit: 0, bass: 0, keys: -0.22, pluck: 0.2, pad: 0.3,
  };

  for (const t of p.tracks) {
    const tv = targetVol[t.instrument];
    if (tv !== undefined && Math.abs(linToDb(t.volume) - linToDb(tv)) > 1.2) {
      findings.push(`${t.name} sits at ${dbLabel(t.volume)} dB — moving to ${dbLabel(tv)} dB for headroom`);
      items.push({ label: `${t.name}: volume → ${dbLabel(tv)} dB`, command: { op: "set_track_volume", trackId: t.id, value: tv } });
    }
    const tp = targetPan[t.instrument];
    if (tp !== undefined && Math.abs(t.pan - tp) > 0.08) {
      items.push({ label: `${t.name}: pan ${tp === 0 ? "center" : tp < 0 ? `${Math.round(-tp * 100)}% L` : `${Math.round(tp * 100)}% R`}`, command: { op: "set_track_pan", trackId: t.id, value: tp } });
    }
  }

  const bass = findKind(p, "bass");
  const keys = findKind(p, "keys");
  if (bass && keys) {
    findings.push("Bass and keys share low-mid range — a gentle lowpass on keys reduces masking");
    items.push({ label: "Keys: lowpass at 6.5 kHz (unmasks the bass)", command: { op: "set_track_fx", trackId: keys.id, fx: { cutoff: 6500 } } });
  }
  const pad = findKind(p, "pad");
  if (pad) items.push({ label: "Pad: 50% reverb send for depth", command: { op: "set_track_fx", trackId: pad.id, fx: { reverb: 0.5 } } });
  const lead = findKind(p, "pluck");
  if (lead) items.push({ label: "Lead: 20% delay send for space", command: { op: "set_track_fx", trackId: lead.id, fx: { delay: 0.2 } } });

  if (items.length === 0) {
    return { kind: "reply", text: "Your balance already looks healthy — volumes are within ~1 dB of a typical mix, and the master limiter is catching peaks. Try asking me to add parts or energy instead." };
  }

  return {
    kind: "plan",
    title: "Mix pass — balance, space, masking",
    summary: `Analyzed ${p.tracks.length} tracks. ${findings.slice(0, 2).join("; ")}. The master limiter stays on to catch peaks. One undo reverts the whole pass.`,
    items,
  };
}

function arrangePlan(p: Project, rng: Rng): AiResult {
  const items: PlanItem[] = [];
  const bars = 16;
  const rootMidi = p.rootMidi;
  const scale = p.scale;
  const s = SCALES[scale];
  void s;

  items.push({ label: "Extend the timeline to 16 bars", command: { op: "set_length", bars } });
  items.push({ label: "Clear current placements to re-structure", command: { op: "clear_placements" } });

  const mk = (name: string, notes: Note[], lengthBars: number): Clip => ({ id: uid("clip"), name, lengthBars, notes });

  const drums = ensureTrack(p, "drumkit", items, [], "Drums", "#ff6f61");
  const bass = ensureTrack(p, "bass", items, [], "Bass", "#f0a848");
  const keys = ensureTrack(p, "keys", items, [], "Keys", "#3ecfb2");
  const lead = ensureTrack(p, "pluck", items, [], "Lead", "#58b7f5");
  const pad = ensureTrack(p, "pad", items, [], "Pad", "#a78bfa");

  const introPerc = mk("Intro Perc", genDrums(rng, 0, 1), 1);
  const verseBeat = mk("Verse Beat", genDrums(rng, 1, 1), 1);
  const chorusBeat = mk("Chorus Beat", genDrums(rng, 2, 1), 1);
  const fill = mk("Fill", genDrums(rng, 2, 1, { fill: true }), 1);
  items.push({ label: "Intro: sparse percussion (bar 2)", command: { op: "create_clip", trackId: drums.id, clip: introPerc, placeBars: [1] } });
  items.push({ label: "Verse: steady groove (bars 3–6)", command: { op: "create_clip", trackId: drums.id, clip: verseBeat, placeBars: [2, 3, 4, 5] } });
  items.push({ label: "Chorus: full drums (bars 7–10, 13–15)", command: { op: "create_clip", trackId: drums.id, clip: chorusBeat, placeBars: [6, 7, 8, 9, 12, 13, 14] } });
  items.push({ label: "Drum fill into the final bar", command: { op: "create_clip", trackId: drums.id, clip: fill, placeBars: [15] } });

  const verseBass = mk("Verse Bass", genBass(rng, rootMidi, scale, 2, 1), 2);
  const chorusBass = mk("Chorus Bass", genBass(rng, rootMidi, scale, 2, 2), 2);
  items.push({ label: "Bass: verse motion (bars 3–6)", command: { op: "create_clip", trackId: bass.id, clip: verseBass, placeBars: [2, 4] } });
  items.push({ label: "Bass: driving chorus (bars 7–10, 13–16)", command: { op: "create_clip", trackId: bass.id, clip: chorusBass, placeBars: [6, 8, 12, 14] } });

  const verseChords = mk("Verse Chords", genChords(rng, rootMidi, scale, 4, 1), 4);
  const chorusChords = mk("Chorus Stabs", genChords(rng, rootMidi, scale, 4, 2), 4);
  items.push({ label: "Chords: verse voicing (bars 3–6)", command: { op: "create_clip", trackId: keys.id, clip: verseChords, placeBars: [2] } });
  items.push({ label: "Chords: chorus stabs (bars 7–10)", command: { op: "create_clip", trackId: keys.id, clip: chorusChords, placeBars: [6] } });
  items.push({ label: "Chords reprise (bars 13–16)", command: { op: "place_clip", trackId: keys.id, clipId: chorusChords.id, bar: 12 } });

  const hook = mk("Chorus Hook", genMelody(rng, rootMidi, scale, 2, 1), 2);
  items.push({ label: "Hook melody over both choruses", command: { op: "create_clip", trackId: lead.id, clip: hook, placeBars: [6, 8, 12, 14] } });

  const wash = mk("Intro Wash", padFromChords(genChords(rng, rootMidi, scale, 4, 0), rootMidi), 4);
  items.push({ label: "Pad wash across the intro (bars 1–4)", command: { op: "create_clip", trackId: pad.id, clip: wash, placeBars: [0] } });
  items.push({ label: "Pad returns for the bridge (bars 11–12)", command: { op: "place_clip", trackId: pad.id, clipId: wash.id, bar: 10 } });

  return {
    kind: "plan",
    title: "Structure: intro → verse → chorus → bridge → chorus",
    summary: `Turns your ${p.lengthBars}-bar loop into a 16-bar arrangement with contrast between sections — the fastest way to hear a "song" instead of a loop. Everything lands as normal clips you can edit afterwards.`,
    items,
  };
}

/* ---------------- knowledge base ---------------- */

function keyName(p: Project) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[((p.rootMidi % 12) + 12) % 12]} ${p.scale}`;
}

const GLOSSARY: [RegExp, string][] = [
  [/\b(compressor|compression)\b/, "A compressor quietly turns down the loudest moments so the quiet parts feel closer in volume. Think of it as an automatic hand on the volume fader — it makes tracks sound solid and 'glued' instead of jumpy. In Cadence the master chain has a gentle limiter (an extreme compressor) so your song never distorts."],
  [/\blimiter\b/, "A limiter is a brick-wall compressor: nothing can get louder than the ceiling you set. Cadence keeps one on the master output so even dense arrangements can't clip (distort) on export."],
  [/\b(eq|equaliz|equalis)\b/, "An EQ boosts or cuts specific frequency ranges — bass (low), mids (where vocals live), treble (high/air). Producers use EQ to carve space: e.g. cutting a little low-end from keys so the bass owns that range."],
  [/\breverb\b/, "Reverb simulates the reflections of a room, from a small bathroom to a huge hall. A little makes instruments feel real; a lot makes them feel far away and dreamy. Try the reverb send on the Pad in the mixer."],
  [/\bdelay\b/, "Delay repeats a sound after a set time — echo! When synced to tempo, echoes land on the beat and add rhythm. The pluck lead loves a subtle 25% delay send."],
  [/\bsidechain\b/, "Sidechaining ducks one track whenever another plays — classically: the pad volume dips every time the kick hits, creating that pumping dance feel. It's mostly used to stop the kick and bass from fighting."],
  [/\bquantiz|timing\b/, "Quantize snaps notes to the nearest grid line (like 1/16 notes) so human-played parts lock perfectly to tempo. Great for tightening; overuse makes things robotic — many producers quantize to ~80% strength."],
  [/\bvelocity\b/, "Velocity is how hard a note is hit (0–127 in MIDI). Higher velocity = louder and often brighter. Varying velocity between notes is the #1 trick for making programmed drums feel human. In the step sequencer, click a lit cell again to accent it."],
  [/\bmidi\b/, "MIDI is just performance data — note, pitch, length, velocity — not sound itself. That's why a MIDI clip can play through any instrument, be transposed, and edited note by note in the piano roll."],
  [/\b(low ?pass|high ?pass|filter)\b/, "A filter removes frequencies. A low-pass keeps the lows and rolls off the highs (darker, underwater feel); a high-pass does the opposite. The mixer's cutoff knob is a low-pass — sweep it down on the keys and listen."],
  [/\bclip(ping)?|distort\b/, "Clipping happens when a signal exceeds 0 dBFS — the waveform gets chopped flat and sounds harsh. Keep individual tracks under ~-6 dB and let the master limiter catch the peaks."],
  [/\bheadroom\b/, "Headroom is the safety space between your loudest peak and 0 dB. Mixing with headroom (peaks around -6 dB) keeps effects sounding clean and mastering easy."],
  [/\b(bus|send|aux)\b/, "A bus (or send) routes copies of several tracks into one shared effect — like one reverb every instrument can 'send' a little of its signal into. It saves CPU and makes everything sound like it's in the same room. Cadence's reverb is a shared bus."],
  [/\barrange|arrangement\b/, "Arranging is deciding what plays when: intro, verse, chorus, bridge. Loops become songs through contrast — drop the drums for a verse, bring everything back for the chorus. Ask me to 'arrange my song' and watch it happen."],
  [/\bbpm|tempo\b/, "BPM = beats per minute, the speed of your song. Ballads sit around 60–80, hip-hop 80–100, house 120–128, drum & bass 160+. Every clip in Cadence snaps to the project BPM grid."],
  [/\b(waveform|sample|audio clip)\b/, "A waveform is the picture of a sound's pressure over time — tall spikes are loud moments. Audio clips contain real recorded sound; MIDI clips contain notes. Cadence currently works with MIDI clips, which is ideal for learning."],
  [/\b(transpose|key|scale|minor|major)\b/, "The key is your song's gravitational center — a set of notes that sound 'right' together. Minor keys lean sad/serious, major leans bright/happy. Transposing shifts every note up or down while keeping the same pattern of intervals."],
];

function glossary(text: string): string | null {
  for (const [re, answer] of GLOSSARY) if (re.test(text)) return answer;
  if (/(music|production|produce|start|begin|learn)/.test(text)) {
    return "Start tiny: 1) press play and listen to the demo song, 2) open the step sequencer and toggle one drum cell, 3) ask me to 'add a melody'. Three wins in five minutes beats reading a manual. Ask me about any term — compressor, reverb, sidechain, quantize…";
  }
  return null;
}

const CAPABILITIES = `Here's what I can do — everything I change is one Ctrl+Z away:

• Create parts — "make a beat", "add a melody", "add chords", "add a bassline", "add a pad"
• Shape energy — "make it more energetic" or "make it chill"
• Structure — "arrange my song" (turns your loop into intro/verse/chorus)
• Mix — "fix my mix" (analyzes levels, masking and space)
• Direct commands — "make the drums louder", "pan the keys left", "set tempo to 128", "transpose the lead up 3", "mute the bass"
• Teach — "what is a compressor?", "what is sidechain?", "how do I start?"`;
