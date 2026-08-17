import { useEffect, useRef, useState } from "react";
import { INSTRUMENT_META, Project, Track } from "../types";
import { useStore } from "../state/store";
import { getEngine } from "../audio/engine";
import { IconMinus, IconPlus } from "./icons";

const HEADER_W = 184;
const ROW_H = 46;

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export default function Timeline() {
  const { state, apply, selectTrack, setEditorClip } = useStore();
  const p = state.project;
  const [barW, setBarW] = useState(62);
  const playheadRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const barWRef = useRef(barW);
  barWRef.current = barW;

  useEffect(() => {
    const engine = getEngine();
    let raf = 0;
    const tick = () => {
      const step = engine.getCurrentStep();
      const x = HEADER_W + (step / 16) * barWRef.current;
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
      const el = scrollRef.current;
      if (el && engine.playing) {
        const visRight = el.scrollLeft + el.clientWidth;
        if (x > visRight - 40) el.scrollLeft = x - el.clientWidth * 0.5;
        else if (x < el.scrollLeft + HEADER_W) el.scrollLeft = Math.max(0, x - HEADER_W - 20);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const place = (t: Track, bar: number) => {
    apply(`Place ${p.clips[t.sourceClipId]?.name ?? "clip"}`, [{ op: "place_clip", trackId: t.id, clipId: t.sourceClipId, bar }]);
  };
  const removePlacement = (t: Track, placementId: string) => {
    apply("Remove clip", [{ op: "remove_placement", trackId: t.id, placementId }]);
  };

  const total = p.lengthBars;

  return (
    <div className="panel flex flex-col h-[248px] shrink-0 anim-fade-up overflow-hidden" style={{ animationDelay: "80ms" }}>
      {/* toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-ink-700/70">
        <span className="panel-title">Arrangement</span>
        <span className="text-[10px] font-mono text-ink-400">{total} bars · 4/4</span>
        <div className="flex-1" />
        <span className="text-[10px] text-ink-400 hidden lg:block">click = paint clip · click block = edit · right-click block = remove</span>
        <div className="w-px h-4 bg-ink-700" />
        <button className="btn btn-ghost py-1! px-1.5!" title="Zoom out" onClick={() => setBarW((w) => Math.max(40, w - 12))}><IconMinus size={13} /></button>
        <button className="btn btn-ghost py-1! px-1.5!" title="Zoom in" onClick={() => setBarW((w) => Math.min(120, w + 12))}><IconPlus size={13} /></button>
        <div className="w-px h-4 bg-ink-700" />
        <button className="btn py-1! px-2! text-[11px]!" title="Add 4 bars to the timeline" onClick={() => apply("Extend timeline", [{ op: "set_length", bars: total + 4 }])}>+4 bars</button>
        <button className="btn btn-ghost py-1! px-2! text-[11px]!" title="Remove the last 4 bars" disabled={total <= 4} onClick={() => apply("Shorten timeline", [{ op: "set_length", bars: total - 4 }])}>−4</button>
      </div>

      {/* grid */}
      <div ref={scrollRef} className="flex-1 overflow-auto relative">
        <div className="relative min-w-max">
          {/* ruler */}
          <div className="flex sticky top-0 z-30 bg-ink-850 border-b border-ink-700" style={{ height: 22 }}>
            <div className="sticky left-0 z-40 bg-ink-850 shrink-0 px-3 flex items-center panel-title" style={{ width: HEADER_W }}>Tracks</div>
            {Array.from({ length: total }, (_, b) => (
              <div
                key={b}
                style={{ width: barW }}
                className={`shrink-0 border-r border-ink-750 flex items-end px-1.5 pb-0.5 font-mono text-[9px] ${b % 4 === 0 ? "text-amber-glow/90 bg-ink-800/60" : "text-ink-400/70"}`}
              >
                {b + 1}
              </div>
            ))}
          </div>

          {/* rows */}
          {p.tracks.map((t) => {
            const selected = t.id === state.selectedTrackId;
            return (
              <div key={t.id} className="flex border-b border-ink-750/70 group/row" style={{ height: ROW_H }}>
                {/* track header */}
                <div
                  className={`sticky left-0 z-20 shrink-0 flex items-center gap-2 px-2.5 border-r border-ink-700 cursor-pointer transition-colors ${selected ? "bg-ink-800" : "bg-ink-850 group-hover/row:bg-ink-800/60"}`}
                  style={{ width: HEADER_W, boxShadow: selected ? `inset 3px 0 0 ${t.color}` : undefined }}
                  onClick={() => selectTrack(t.id)}
                >
                  <span className="w-2.5 h-2.5 rounded-[4px] shrink-0 shadow-[0_0_8px_rgba(0,0,0,0.4)]" style={{ background: t.color }} />
                  <div className="min-w-0 flex-1 leading-tight">
                    <input
                      key={t.name}
                      defaultValue={t.name}
                      onBlur={(e) => { if (e.target.value.trim() && e.target.value !== t.name) apply("Rename track", [{ op: "rename_track", trackId: t.id, name: e.target.value.trim() }]); }}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      onClick={(e) => e.stopPropagation()}
                      className="w-full bg-transparent text-[12px] font-semibold text-ink-100 focus:outline-none focus:bg-ink-950 rounded px-1 -mx-1 border border-transparent focus:border-ink-600"
                      aria-label={`Rename ${t.name}`}
                    />
                    <div className="text-[9px] text-ink-400 px-0">{INSTRUMENT_META[t.instrument].label} · {t.clipIds.length} clip{t.clipIds.length > 1 ? "s" : ""}</div>
                  </div>
                  {/* clip chips */}
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    {[...t.clipIds].reverse().slice(0, 2).map((cid) => (
                      <button
                        key={cid}
                        title={`Edit ${p.clips[cid]?.name ?? "clip"}`}
                        onClick={() => { selectTrack(t.id); setEditorClip(cid); }}
                        className={`text-[9px] font-mono px-1.5 py-1 rounded border transition-colors ${state.editorClipId === cid && selected ? "border-amber-glow/60 text-amber-glow bg-amber-glow/10" : "border-ink-700 text-ink-400 hover:text-ink-100"}`}
                      >
                        {(p.clips[cid]?.name ?? "?").slice(0, 6)}
                      </button>
                    ))}
                    {t.mute && <span className="text-[8px] font-bold text-rec font-mono">M</span>}
                  </div>
                </div>

                {/* bar cells */}
                <div className="relative" style={{ width: total * barW }}>
                  {Array.from({ length: total }, (_, b) => (
                    <div
                      key={b}
                      onClick={() => place(t, b)}
                      className={`cell absolute top-0 bottom-0 border-r cursor-copy ${Math.floor(b / 4) % 2 === 0 ? "bg-ink-900/30" : "bg-ink-900/60"} border-ink-750/60`}
                      style={{ left: b * barW, width: barW }}
                      title={`Paint "${p.clips[t.sourceClipId]?.name}" on bar ${b + 1}`}
                    />
                  ))}
                  {/* placed clips */}
                  {t.placements.map((pl) => {
                    const clip = p.clips[pl.clipId];
                    if (!clip) return null;
                    return (
                      <div
                        key={pl.id}
                        onClick={(e) => {
                          if (e.altKey) { removePlacement(t, pl.id); return; }
                          selectTrack(t.id);
                          setEditorClip(pl.clipId);
                        }}
                        onContextMenu={(e) => { e.preventDefault(); removePlacement(t, pl.id); }}
                        title={`${clip.name} — click to edit, right-click to remove`}
                        className="absolute top-[4px] bottom-[4px] rounded-md cursor-pointer select-none overflow-hidden transition-all duration-150 hover:brightness-125 hover:-translate-y-px"
                        style={{
                          left: pl.bar * barW + 1.5,
                          width: clip.lengthBars * barW - 4,
                          background: `linear-gradient(180deg, ${rgba(t.color, 0.34)}, ${rgba(t.color, 0.16)})`,
                          border: `1px solid ${rgba(t.color, 0.55)}`,
                          boxShadow: state.editorClipId === pl.clipId && selected ? `0 0 0 1.5px ${t.color}, 0 4px 14px ${rgba(t.color, 0.25)}` : `0 2px 8px rgba(0,0,0,0.35)`,
                        }}
                      >
                        <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: t.color }} />
                        <div className="pl-2 pr-1 pt-0.5 text-[10px] font-semibold truncate" style={{ color: "var(--color-ink-100)" }}>{clip.name}</div>
                        <div className="pl-2 font-mono text-[8px] text-ink-200/70">{clip.notes.length} notes</div>
                        {/* mini waveform-ish stripes */}
                        <div className="absolute left-2 right-1 bottom-1 h-[7px] flex items-end gap-[2px] opacity-70">
                          {Array.from({ length: Math.min(24, Math.max(4, Math.floor((clip.lengthBars * barW) / 9))) }, (_, i) => {
                            const has = clip.notes.some((n) => Math.floor(n.start / Math.max(1, (clip.lengthBars * 16) / 24)) === i);
                            return <span key={i} className="flex-1 rounded-[1px]" style={{ height: has ? `${35 + ((i * 37) % 60)}%` : "18%", background: has ? rgba(t.color, 0.9) : rgba(t.color, 0.25) }} />;
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* playhead */}
          <div ref={playheadRef} className="absolute top-0 bottom-0 z-20 pointer-events-none will-change-transform" style={{ left: 0 }}>
            <div className="w-[2px] h-full bg-amber-glow shadow-[0_0_10px_rgba(255,180,84,0.8)]" />
            <div className="absolute -top-0 -left-[5px] w-0 h-0 border-l-[6px] border-r-[6px] border-t-[7px] border-l-transparent border-r-transparent border-t-amber-glow" />
          </div>
        </div>
      </div>
    </div>
  );
}
