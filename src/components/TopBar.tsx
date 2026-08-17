import { useEffect, useRef, useState } from "react";
import { Mode } from "../types";
import { useStore } from "../state/store";
import { audio, buildEmptyProject, parseProjectFile, serialize } from "../core";
import { BrandMark, IconDownload, IconFolderOpen, IconPlus, IconRedo, IconSave, IconUndo } from "./icons";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "beginner", label: "Beginner", hint: "The essentials only — just make music" },
  { id: "producer", label: "Producer", hint: "Panning, solo, clip tools" },
  { id: "advanced", label: "Advanced", hint: "Sends, filters, drive, diagnostics" },
];

export default function TopBar({ onToast, playing }: { onToast: (msg: string) => void; playing: boolean }) {
  const { state, apply, undo, redo, setMode, loadProject, saveNow } = useStore();
  const [name, setName] = useState(state.project.name);
  const [exporting, setExporting] = useState(false);

  // stay in sync when a template/new session is loaded
  useEffect(() => setName(state.project.name), [state.project.name]);

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== state.project.name) {
      apply("Rename project", [{ op: "set_project_name", name: trimmed }]);
    } else {
      setName(state.project.name);
    }
  };

  const exportWav = async () => {
    setExporting(true);
    try {
      const blob = await audio.exportWav(state.project);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${state.project.name.replace(/[^\w\- ]+/g, "") || "cadence-mix"}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      onToast("Rendered 16-bit WAV — check your downloads");
    } catch {
      onToast("Export failed — your browser blocked offline rendering");
    } finally {
      setExporting(false);
    }
  };

  const fileRef = useRef<HTMLInputElement>(null);

  const saveFile = () => {
    const blob = new Blob([serialize(state.project)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.project.name.replace(/[^\w\- ]+/g, "").trim() || "session"}.open-daw.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    onToast("Project saved as .open-daw.json — open it again any time");
  };

  const openFile = async (file: File) => {
    const text = await file.text();
    const res = parseProjectFile(text);
    if (!res.ok) {
      onToast(`Can't open that file — ${res.error.toLowerCase()}`);
      return;
    }
    loadProject(res.project);
    onToast(`Opened "${res.project.name}" — validated ${res.project.tracks.length} tracks`);
  };

  const lastUndo = state.undoLabel;
  const lastRedo = state.redoLabel;

  return (
    <header className="flex items-center gap-3 px-3 h-14 border-b border-ink-700 bg-ink-900/90 shrink-0 anim-fade-up">
      <div className="flex items-center gap-2.5 min-w-0">
        <BrandMark size={30} />
        <div className="leading-none">
          <div className="font-display font-semibold tracking-[0.12em] text-[14px] text-ink-100">CADENCE</div>
          <div className="text-[9px] tracking-[0.14em] uppercase text-ink-400 mt-1">open-source AI DAW</div>
        </div>
        <div className={`flex items-end gap-[2.5px] h-4 ml-1 ${playing ? "eq-playing" : ""}`} aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="eq-bar" style={{ height: playing ? undefined : `${22 + i * 12}%`, opacity: playing ? 1 : 0.35 }} />
          ))}
        </div>
      </div>

      <div className="w-px h-7 bg-ink-700 mx-1" />

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="bg-ink-800 border border-ink-700 rounded-lg px-3 py-1.5 text-[13px] font-semibold text-ink-100 w-44 focus:outline-none focus:border-amber-glow/60 focus:ring-2 focus:ring-amber-glow/15 transition"
        aria-label="Project name"
      />

      <button className="btn btn-ghost" title="Start a blank session (undoable)" onClick={() => { loadProject(buildEmptyProject()); onToast("Blank session ready — ask the copilot for a beat"); }}>
        <IconPlus size={14} /> New
      </button>

      <div className="flex-1" />

      {/* mode switch */}
      <div className="flex items-center bg-ink-800 border border-ink-700 rounded-lg p-0.5" role="tablist" aria-label="Interface mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            title={m.hint}
            aria-selected={state.mode === m.id}
            onClick={() => { setMode(m.id); onToast(`${m.label} mode — ${m.hint.toLowerCase()}`); }}
            className={`px-3 py-1.5 rounded-md text-[11.5px] font-semibold tracking-wide transition-all duration-150 ${
              state.mode === m.id
                ? "bg-amber-glow text-ink-950 shadow-[0_2px_10px_rgba(255,180,84,0.3)]"
                : "text-ink-400 hover:text-ink-100"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="w-px h-7 bg-ink-700 mx-1" />

      <button className="btn btn-ghost" onClick={undo} disabled={!state.canUndo} title={lastUndo ? `Undo: ${lastUndo}` : "Undo (Ctrl+Z)"}>
        <IconUndo size={15} />
      </button>
      <button className="btn btn-ghost" onClick={redo} disabled={!state.canRedo} title={lastRedo ? `Redo: ${lastRedo}` : "Redo (Ctrl+Shift+Z)"}>
        <IconRedo size={15} />
      </button>

      <div className="w-px h-7 bg-ink-700 mx-1" />

      <button
        className="btn"
        onClick={() => {
          // Atomic known-good save: temp write → verify → rename. Autosave
          // recovery snapshots never touch this location.
          const ok = saveNow();
          onToast(ok ? "Project saved" : "Save failed — storage unavailable");
        }}
        title="Save as your known-good project (atomic write)"
      >
        <IconSave size={14} /> Save
      </button>
      <button className="btn" onClick={() => fileRef.current?.click()} title="Open a .cadence.json project file (schema-validated)">
        <IconFolderOpen size={14} /> Open
      </button>
      <button className="btn" onClick={saveFile} title="Download the project as a .cadence.json file">
        <IconDownload size={14} /> Save file
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,.cadence,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openFile(f).catch(() => onToast("Couldn't read that file"));
          e.target.value = "";
        }}
      />
      <button className="btn btn-primary" onClick={exportWav} disabled={exporting} title="Render the whole song to a WAV file">
        <IconDownload size={14} /> {exporting ? "Rendering…" : "Export WAV"}
      </button>
    </header>
  );
}
