import { WorkspaceView } from "../types";
import { useStore } from "../state/store";
import { IconArrangement, IconMixer, IconPiano, IconDrum, IconSynth, IconZap } from "./icons";

/**
 * Segmented control that swaps the center workspace between
 * Arrangement / Piano Roll / Mixer. One component reads the single global
 * view from the store — no per-mode duplication. The Piano Roll label adapts
 * to the selected track (drum kit → Drum Grid).
 */
export default function WorkspaceSwitcher() {
  const { state, setWorkspaceView } = useStore();
  const selected = state.project.tracks.find((t) => t.id === state.selectedTrackId);
  const isDrum = selected?.instrument === "drumkit";

  const tabs: { id: WorkspaceView; label: string; icon: React.ReactNode; hint: string }[] = [
    { id: "arrangement", label: "Arrangement", icon: <IconArrangement size={15} />, hint: "Timeline — place & move clip blocks" },
    { id: "pianoroll", label: isDrum ? "Drum Grid" : "Piano Roll", icon: isDrum ? <IconDrum size={15} /> : <IconPiano size={15} />, hint: "Edit the notes of the selected clip" },
    { id: "mixer", label: "Mixer", icon: <IconMixer size={15} />, hint: "Levels, pan, sends & effects" },
    { id: "synth", label: "Synth Lab", icon: <IconSynth size={15} />, hint: "Subtractive synth — presets, patch editor & voice headroom" },
    { id: "groove", label: "Groove Box", icon: <IconDrum size={15} />, hint: "Step-sequencer drum machine — patterns, swing & song chain" },
    { id: "fx", label: "FX Rack", icon: <IconZap size={15} />, hint: "Chainable effects — EQ, comp, reverb, delay & more, with live CPU cost" },
  ];

  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === state.workspaceView));

  return (
    <div
      className="relative flex items-center gap-1 p-1 rounded-lg bg-ink-900 border border-ink-750 w-fit"
      role="tablist"
      aria-label="Workspace view"
    >
      {/* sliding active indicator */}
      <span
        aria-hidden
        className="absolute top-1 bottom-1 rounded-md bg-ink-750 border border-ink-600 transition-all duration-200 ease-out"
        style={{
          width: `calc((100% - 8px) / ${tabs.length})`,
          left: `calc(4px + (100% - 8px) / ${tabs.length} * ${activeIndex})`,
        }}
      />
      {tabs.map((t) => {
        const active = t.id === state.workspaceView;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            title={t.hint}
            onClick={() => setWorkspaceView(t.id)}
            className={`relative z-10 flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-[12px] font-semibold tracking-wide transition-colors duration-150 ${
              active ? "text-amber-glow" : "text-ink-400 hover:text-ink-200"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
