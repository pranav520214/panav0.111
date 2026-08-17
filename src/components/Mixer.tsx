import { useEffect, useRef } from "react";
import { Track, TrackFx, dbLabel } from "../types";
import { useStore } from "../state/store";
import { audio } from "../core";
import { IconMixer } from "./icons";

const cutoffToSlider = (f: number) => Math.round((100 * Math.log(f / 300)) / Math.log(60));
const sliderToCutoff = (v: number) => Math.round(300 * Math.pow(60, v / 100));

export default function Mixer() {
  const { state, apply, applySilent, snapshot, gate } = useStore();
  const p = state.project;
  const meterRefs = useRef(new Map<string, HTMLDivElement>());
  const masterRef = useRef<HTMLDivElement>(null);
  const smooth = useRef(new Map<string, number>());

  useEffect(() => {
    const engine = audio;
    let raf = 0;
    const tick = () => {
      for (const t of p.tracks) {
        const el = meterRefs.current.get(t.id);
        if (!el) continue;
        const raw = engine.getTrackLevel(t.id);
        const prev = smooth.current.get(t.id) ?? 0;
        const v = Math.max(raw, prev * 0.86);
        smooth.current.set(t.id, v);
        el.style.height = `${Math.min(100, v * 260)}%`;
      }
      if (masterRef.current) {
        const raw = engine.getMasterLevel();
        const prev = smooth.current.get("__master") ?? 0;
        const v = Math.max(raw, prev * 0.86);
        smooth.current.set("__master", v);
        masterRef.current.style.height = `${Math.min(100, v * 240)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [p.tracks]);

  const fxOn = gate("advanced");      // sends, filters, drive — Advanced only
  const extended = gate("producer");  // pan, solo, mute labels — Producer & up
  const beginner = !extended;

  const volGesture = (t: Track, value: number) => {
    snapshot(`${t.name} volume`);
    applySilent([{ op: "set_track_volume", trackId: t.id, value }]);
  };

  return (
    <section className="panel flex-1 min-h-0 flex flex-col anim-fade-up" style={{ animationDelay: "160ms" }}>
      <div className="flex items-center gap-2 px-3 h-[38px] shrink-0 border-b border-ink-700/60">
        <IconMixer size={14} className="text-amber-glow" />
        <span className="panel-title">Mixer</span>
        <span className="text-[10px] font-mono text-ink-400">{p.tracks.length} tracks + master</span>
        <div className="flex-1" />
        {extended && !fxOn && <span className="text-[9px] text-ink-400 hidden md:block">switch to Advanced for sends, filters & drive</span>}
        {beginner && <span className="text-[9px] text-ink-400 hidden md:block">volume & mute — that's all you need for now</span>}
      </div>

      <div className="flex-1 min-h-0 flex gap-2 overflow-x-auto px-2.5 py-2">
          {p.tracks.map((t) => (
            <Strip key={t.id} t={t} fxOn={fxOn} extended={extended} meterEl={(el) => { if (el) meterRefs.current.set(t.id, el); else meterRefs.current.delete(t.id); }} volGesture={volGesture} apply={apply} applySilent={applySilent} snapshot={snapshot} />
          ))}

          {/* master */}
          <div className="w-[104px] shrink-0 rounded-lg border border-ink-700 bg-ink-800/70 flex flex-col overflow-hidden">
            <div className="h-[3px] bg-gradient-to-r from-teal via-amber-glow to-coral" />
            <div className="px-2 pt-1.5 text-[11px] font-bold text-ink-100">Master</div>
            <div className="flex-1 min-h-0 flex items-stretch gap-2 px-2.5 py-1.5">
              <div className="w-2.5 rounded-sm bg-ink-950 border border-ink-700 overflow-hidden flex items-end">
                <div ref={masterRef} className="w-full rounded-sm" style={{ height: "0%", background: "linear-gradient(180deg, #ff6f61, #ffb454 45%, #3ecfb2)" }} />
              </div>
              <div className="flex-1 flex flex-col justify-center gap-1.5 text-[9px] font-mono text-ink-400">
                <div className="text-teal">LIMITER ON</div>
                <div>-0.1 dBFS ceil</div>
                <div className="text-ink-300">44.1 kHz float</div>
              </div>
            </div>
            <div className="px-2 pb-1.5 text-[9px] font-mono text-ink-400">0.0 dB</div>
          </div>
        </div>
    </section>
  );
}

function Strip({
  t, fxOn, extended, meterEl, volGesture, apply, applySilent, snapshot,
}: {
  t: Track;
  fxOn: boolean;
  extended: boolean;
  meterEl: (el: HTMLDivElement | null) => void;
  volGesture: (t: Track, v: number) => void;
  apply: (label: string, cmds: Parameters<ReturnType<typeof useStore>["apply"]>[1]) => void;
  applySilent: (cmds: Parameters<ReturnType<typeof useStore>["applySilent"]>[0]) => void;
  snapshot: (label: string) => void;
}) {
  const panLabel = t.pan === 0 ? "C" : t.pan < 0 ? `${Math.round(-t.pan * 100)}L` : `${Math.round(t.pan * 100)}R`;

  const fxSlider = (label: string, value: number, onChange: (v: number) => void, fmt: (v: number) => string) => (
    <label className="flex items-center gap-1 text-[8px] font-mono text-ink-400" title={fmt(value)}>
      <span className="w-6">{label}</span>
      <input
        type="range" min={0} max={100} value={Math.round(value * 100)}
        onPointerDown={() => snapshot(`${t.name} ${label}`)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="flex-1 h-3"
      />
    </label>
  );

  return (
    <div
      className={`w-[96px] shrink-0 rounded-lg border flex flex-col overflow-hidden transition-colors ${t.mute ? "border-ink-700 bg-ink-900/60 opacity-70" : "border-ink-700 bg-ink-800/70"}`}
      style={{ boxShadow: t.solo ? `0 0 0 1px ${t.color}88` : undefined }}
    >
      <div className="h-[3px]" style={{ background: t.color }} />
      <div className="px-2 pt-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-bold text-ink-100 truncate flex-1" title={t.name}>{t.name}</span>
      </div>

      <div className="flex-1 min-h-0 flex items-stretch gap-2 px-2.5 py-1.5">
        {/* meter */}
        <div className="w-2 rounded-sm bg-ink-950 border border-ink-700 overflow-hidden flex items-end">
          <div ref={meterEl} className="w-full rounded-sm" style={{ height: "0%", background: `linear-gradient(180deg, #ff6f61, ${t.color} 45%, ${t.color}66)` }} />
        </div>

        <div className="flex-1 flex flex-col items-center min-h-0">
          {/* fader */}
          <div className="flex-1 min-h-0 w-full flex justify-center">
            <input
              type="range" className="fader" min={0} max={125} step={1}
              value={Math.round(t.volume * 100)}
              onPointerDown={() => volGesture(t, t.volume)}
              onChange={(e) => applySilent([{ op: "set_track_volume", trackId: t.id, value: Number(e.target.value) / 100 }])}
              aria-label={`${t.name} volume`}
            />
          </div>
          <div className="font-mono text-[9px] text-ink-300 tabular-nums mt-1">{dbLabel(t.volume)} dB</div>
        </div>
      </div>

      {/* pan */}
      {extended && (
        <div className="px-2 pb-1">
          <input
            type="range" min={-100} max={100} value={Math.round(t.pan * 100)}
            onPointerDown={() => snapshot(`${t.name} pan`)}
            onChange={(e) => applySilent([{ op: "set_track_pan", trackId: t.id, value: Number(e.target.value) / 100 }])}
            onDoubleClick={() => apply(`${t.name} pan center`, [{ op: "set_track_pan", trackId: t.id, value: 0 }])}
            className="w-full h-3"
            title={`Pan (${panLabel}) — double-click to center`}
            aria-label={`${t.name} pan`}
          />
          <div className="text-[8px] font-mono text-ink-400 text-center">{panLabel}</div>
        </div>
      )}

      {/* M/S */}
      <div className="flex gap-1 px-2 pb-1.5">
        <button
          onClick={() => apply(`${t.mute ? "Unmute" : "Mute"} ${t.name}`, [{ op: "set_track_mute", trackId: t.id, value: !t.mute }])}
          className={`flex-1 text-[10px] font-bold py-0.5 rounded border transition-colors ${t.mute ? "bg-rec/25 border-rec/60 text-rec" : "border-ink-700 text-ink-400 hover:text-ink-100"}`}
          title="Mute"
        >
          M
        </button>
        {mode !== "beginner" && (
          <button
            onClick={() => apply(`${t.solo ? "Unsolo" : "Solo"} ${t.name}`, [{ op: "set_track_solo", trackId: t.id, value: !t.solo }])}
            className={`flex-1 text-[10px] font-bold py-0.5 rounded border transition-colors ${t.solo ? "bg-amber-glow/25 border-amber-glow/60 text-amber-glow" : "border-ink-700 text-ink-400 hover:text-ink-100"}`}
            title="Solo — hear only this track"
          >
            S
          </button>
        )}
      </div>

      {/* advanced FX */}
      {fxOn && (
        <div className="border-t border-ink-700/70 px-2 py-1.5 flex flex-col gap-1 bg-ink-900/50">
          {fxSlider("REV", t.fx.reverb, (v) => applySilent([{ op: "set_track_fx", trackId: t.id, fx: { reverb: v } as Partial<TrackFx> }]), (v) => `Reverb send ${Math.round(v * 100)}%`)}
          {fxSlider("DLY", t.fx.delay, (v) => applySilent([{ op: "set_track_fx", trackId: t.id, fx: { delay: v } as Partial<TrackFx> }]), (v) => `Delay send ${Math.round(v * 100)}%`)}
          <label className="flex items-center gap-1 text-[8px] font-mono text-ink-400" title={`Lowpass cutoff ${t.fx.cutoff >= 1000 ? (t.fx.cutoff / 1000).toFixed(1) + " kHz" : t.fx.cutoff + " Hz"}`}>
            <span className="w-6">CUT</span>
            <input
              type="range" min={0} max={100} value={cutoffToSlider(t.fx.cutoff)}
              onPointerDown={() => snapshot(`${t.name} filter`)}
              onChange={(e) => applySilent([{ op: "set_track_fx", trackId: t.id, fx: { cutoff: sliderToCutoff(Number(e.target.value)) } }])}
              className="flex-1 h-3"
            />
          </label>
          {fxSlider("DRV", t.fx.drive, (v) => applySilent([{ op: "set_track_fx", trackId: t.id, fx: { drive: v } as Partial<TrackFx> }]), (v) => `Drive ${Math.round(v * 100)}%`)}
        </div>
      )}
    </div>
  );
}
