import { useRef, useState } from "react";
import { Note, STEPS_PER_BAR, midiName, uid } from "../types";
import { SCALES, genMelody, mulberry32 } from "../theory";
import { useStore } from "../state/store";
import { useEditorClip } from "../state/useEditorClip";
import { audio } from "../core";
import { IconEraser, IconSparkles } from "./icons";

const LABEL_W = 64;
const CELL_W = 22;
const ROW_H = 20;

const KEYCAPS: Record<number, string> = { 0: "A", 1: "W", 2: "S", 3: "E", 4: "D", 5: "F", 6: "T", 7: "G", 8: "Y", 9: "H", 10: "U", 11: "J", 12: "K", 13: "O", 14: "L", 15: "P" };
const NOTE_LENGTHS: [number, string][] = [[1, "1/16"], [2, "1/8"], [4, "1/4"], [8, "1/2"]];

export default function PianoRoll() {
  const { state, apply } = useStore();
  const ec = useEditorClip();
  const [noteLen, setNoteLen] = useState(2);
  const [snap, setSnap] = useState(true);
  const gridRef = useRef<HTMLDivElement>(null);

  if (!ec || ec.track.instrument === "drumkit") return null;
  const { track, clip } = ec;
  const p = state.project;
  const totalSteps = clip.lengthBars * STEPS_PER_BAR;
  const hi = p.rootMidi + 27;
  const lo = track.instrument === "bass" ? p.rootMidi - 15 : p.rootMidi - 2;
  const rows: number[] = [];
  for (let m = hi; m >= lo; m--) rows.push(m);

  const inScale = (midi: number) => SCALES[p.scale].includes(((midi - p.rootMidi) % 12 + 12) % 12);
  const snapPitch = (midi: number) => {
    if (!snap || inScale(midi)) return midi;
    for (let d = 1; d <= 2; d++) { if (inScale(midi + d)) return midi + d; if (inScale(midi - d)) return midi - d; }
    return midi;
  };

  const setNotes = (notes: Note[], label: string, extra?: { lengthBars?: number; name?: string }) =>
    apply(label, [{ op: "set_clip_content", clipId: clip.id, notes, ...extra }]);

  const clickRow = (e: React.MouseEvent, pitch: number) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const start = Math.max(0, Math.min(totalSteps - 1, Math.floor((e.clientX - rect.left) / CELL_W)));
    const existing = clip.notes.find((n) => n.pitch === pitch && start >= n.start && start < n.start + n.dur);
    if (existing) {
      setNotes(clip.notes.filter((n) => n.id !== existing.id), "Erase note");
      return;
    }
    const snapped = snapPitch(pitch);
    const dur = Math.min(noteLen, totalSteps - start);
    const vel = e.shiftKey ? 1 : 0.85;
    setNotes([...clip.notes, { id: uid("n"), pitch: snapped, start, dur, vel }], "Draw note");
    audio.previewNote(track.id, snapped, 0.8, 0.4);
  };

  const suggest = () => {
    const rng = mulberry32((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
    setNotes(genMelody(rng, p.rootMidi, p.scale, clip.lengthBars, 1), "Copilot: sketch melody");
  };

  const stripeBg = `repeating-linear-gradient(90deg, transparent 0, transparent ${CELL_W * 4 - 1}px, rgba(58,68,92,0.55) ${CELL_W * 4 - 1}px, rgba(58,68,92,0.55) ${CELL_W * 4}px), repeating-linear-gradient(90deg, transparent 0, transparent ${CELL_W * 16 - 1}px, rgba(107,118,144,0.5) ${CELL_W * 16 - 1}px, rgba(107,118,144,0.5) ${CELL_W * 16}px)`;

  return (
    <div className="panel flex-1 min-h-0 flex flex-col anim-fade-up" style={{ animationDelay: "120ms" }}>
      {/* toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ink-700/70 shrink-0 flex-wrap">
        <span className="panel-title">Piano Roll</span>
        <span className="w-2 h-2 rounded-[3px]" style={{ background: track.color }} />
        <input
          key={clip.name}
          defaultValue={clip.name}
          onBlur={(e) => e.target.value.trim() && e.target.value !== clip.name && apply("Rename clip", [{ op: "set_clip_content", clipId: clip.id, notes: clip.notes, name: e.target.value.trim() }])}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="bg-ink-800 border border-ink-700 rounded-md px-2 py-1 text-[12px] font-semibold w-28 focus:outline-none focus:border-amber-glow/60"
          aria-label="Clip name"
        />
        <div className="flex items-center gap-1 text-[11px] text-ink-400">
          Length
          {[1, 2, 4, 8].map((b) => (
            <button
              key={b}
              onClick={() => setNotes(clip.notes.filter((n) => n.start < b * STEPS_PER_BAR), `Clip length ${b} bar${b > 1 ? "s" : ""}`, { lengthBars: b })}
              className={`px-2 py-0.5 rounded-md font-mono border transition-colors ${clip.lengthBars === b ? "border-amber-glow/60 text-amber-glow bg-amber-glow/10" : "border-ink-700 text-ink-400 hover:text-ink-100"}`}
            >
              {b}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-ink-400">
          Note
          {NOTE_LENGTHS.map(([v, label]) => (
            <button key={v} onClick={() => setNoteLen(v)} className={`px-2 py-0.5 rounded-md font-mono border transition-colors ${noteLen === v ? "border-teal/60 text-teal bg-teal/10" : "border-ink-700 text-ink-400 hover:text-ink-100"}`}>
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setSnap((s) => !s)}
          title="Snap new notes to the project scale — keeps everything in key"
          className={`chip py-1! ${snap ? "text-teal! border-teal/50! bg-teal/10!" : ""}`}
        >
          Scale snap {snap ? "on" : "off"}
        </button>
        <div className="flex-1" />
        <span className="text-[10px] text-ink-400 hidden xl:block">click = draw · click note = erase · shift+click = accent · keys A–K row plays live</span>
        <button className="btn py-1! px-2! text-[11px]!" onClick={suggest} title="Let the copilot sketch a melody in key">
          <IconSparkles size={13} /> Suggest
        </button>
        <button className="btn btn-ghost btn-danger py-1! px-2! text-[11px]!" onClick={() => setNotes([], "Clear notes")}>
          <IconEraser size={13} /> Clear
        </button>
      </div>

      {/* grid */}
      <div className="flex-1 min-h-0 overflow-auto relative" ref={gridRef}>
        <div className="min-w-max">
          {rows.map((midi) => {
            const scale = inScale(midi);
            const tonic = ((midi - p.rootMidi) % 12 + 12) % 12 === 0;
            const semisFromPlayOctave = midi - (p.rootMidi + 12);
            const cap = KEYCAPS[semisFromPlayOctave];
            const rowNotes = clip.notes.filter((n) => n.pitch === midi);
            const dark = !scale;
            return (
              <div key={midi} className="flex items-stretch">
                <div
                  className={`shrink-0 sticky left-0 z-10 border-r border-ink-700 flex items-center justify-between px-2 font-mono text-[9px] ${
                    tonic ? "bg-amber-glow/15 text-amber-glow" : scale ? "bg-ink-800 text-ink-200" : "bg-ink-850 text-ink-400/60"
                  }`}
                  style={{ width: LABEL_W, height: ROW_H }}
                >
                  <span>{midiName(midi)}</span>
                  {cap && <span className="key-cap relative bottom-0 right-0">{cap}</span>}
                </div>
                <div
                  className="relative cursor-crosshair"
                  style={{ width: totalSteps * CELL_W, height: ROW_H, background: dark ? "rgba(14,17,22,0.75)" : "rgba(23,28,37,0.65)", backgroundImage: stripeBg }}
                  onClick={(e) => clickRow(e, midi)}
                >
                  {rowNotes.map((n) => (
                    <div
                      key={n.id}
                      onClick={(e) => { e.stopPropagation(); setNotes(clip.notes.filter((x) => x.id !== n.id), "Erase note"); }}
                      title={`${midiName(n.pitch)} · vel ${Math.round(n.vel * 100)} — click to erase`}
                      className="note-block absolute rounded-[3px] cursor-pointer"
                      style={{
                        left: n.start * CELL_W + 1,
                        width: Math.max(6, n.dur * CELL_W - 2),
                        top: 2,
                        height: ROW_H - 4,
                        background: n.vel >= 1 ? `linear-gradient(180deg, #fff4, ${track.color})` : `${track.color}cc`,
                        border: `1px solid ${track.color}`,
                        boxShadow: `0 1px 6px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.25)`,
                      }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        {clip.notes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-[12px] text-ink-400 bg-ink-900/85 border border-ink-700 rounded-lg px-4 py-2.5">
              Click the grid to draw notes — they snap to <span className="text-amber-glow">{midiName(p.rootMidi).replace(/\d/, "")} {p.scale}</span>. Or press <span className="text-amber-glow font-semibold">Suggest</span>.
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-ink-700/70 text-[10px] font-mono text-ink-400 flex gap-4 shrink-0">
        <span>{clip.notes.length} notes</span>
        <span>{clip.lengthBars} bar{clip.lengthBars > 1 ? "s" : ""}</span>
        <span className="text-teal/80">in {midiName(p.rootMidi).replace(/\d/, "")} {p.scale}</span>
      </div>
    </div>
  );
}
