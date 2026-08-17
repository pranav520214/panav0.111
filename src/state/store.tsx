/* React binding for the command bus.
 *
 * The bus (src/core/bus.ts) is the single source of truth for project state.
 * This provider mirrors it into React and layers UI-local state on top
 * (UX mode, selection, mixer visibility). Components never write state
 * directly — they call apply(), which dispatches named Commands through
 * the bus; undo/redo are bus operations too, so user edits and AI edits
 * share one history. */

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { MODE_ORDER, Mode, Project, WorkspaceView } from "../types";
import { Command } from "../core/commands";
import { bus, CommandValidationError } from "../core/bus";

export interface StoreState {
  project: Project;
  mode: Mode;
  workspaceView: WorkspaceView;
  aiPanelOpen: boolean;
  selectedTrackId: string;
  editorClipId: string | null;
  mixerOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

const MODE_KEY = "cadence.mode";
const VIEW_KEY = "cadence.workspaceView";
const AI_KEY = "cadence.aiPanelOpen";

const readMode = (): Mode => {
  const m = localStorage.getItem(MODE_KEY);
  return m === "producer" || m === "advanced" ? m : "beginner";
};

const readView = (): WorkspaceView => {
  const v = localStorage.getItem(VIEW_KEY);
  return v === "pianoroll" || v === "mixer" ? v : "arrangement";
};

const readAiOpen = (): boolean => localStorage.getItem(AI_KEY) !== "0";

/** Merge the bus's current truth into React state, keeping selection valid. */
function syncFromBus(s: StoreState): StoreState {
  const p = bus.getState();
  const selectedTrackId = p.tracks.some((t) => t.id === s.selectedTrackId)
    ? s.selectedTrackId
    : p.tracks[0]?.id ?? "";
  const selected = p.tracks.find((t) => t.id === selectedTrackId);
  const editorClipId = s.editorClipId && p.clips[s.editorClipId]
    ? s.editorClipId
    : selected?.sourceClipId ?? null;
  return {
    ...s,
    project: p,
    selectedTrackId,
    editorClipId,
    canUndo: bus.canUndo,
    canRedo: bus.canRedo,
    undoLabel: bus.undoLabel(),
    redoLabel: bus.redoLabel(),
  };
}

function initState(): StoreState {
  const p = bus.getState();
  return syncFromBus({
    project: p,
    mode: readMode(),
    workspaceView: readView(),
    aiPanelOpen: readAiOpen(),
    selectedTrackId: p.tracks[0]?.id ?? "",
    editorClipId: p.tracks[0]?.sourceClipId ?? null,
    mixerOpen: true,
    canUndo: bus.canUndo,
    canRedo: bus.canRedo,
    undoLabel: bus.undoLabel(),
    redoLabel: bus.redoLabel(),
  });
}

export interface StoreApi {
  state: StoreState;
  /**
   * Progressive disclosure, expressed as "visible from this mode".
   * gate("producer") is true in Producer AND Advanced; gate("advanced") only in
   * Advanced. Components reveal controls with this instead of comparing mode
   * strings, so the Beginner ⊂ Producer ⊂ Advanced ordering lives in one place.
   */
  gate: (threshold: Mode) => boolean;
  /** Dispatch commands through the bus; snapshot before → one undo reverts the batch. */
  apply: (label: string, commands: Command[]) => void;
  /** Same pipeline, no history entry (used while live-recording notes). */
  applySilent: (commands: Command[]) => void;
  /** Mark an undo checkpoint (e.g. before a recording take). */
  snapshot: (label: string) => void;
  undo: () => void;
  redo: () => void;
  setMode: (mode: Mode) => void;
  setWorkspaceView: (view: WorkspaceView) => void;
  setAiPanel: (open: boolean) => void;
  selectTrack: (trackId: string) => void;
  setEditorClip: (clipId: string) => void;
  toggleMixer: () => void;
  loadProject: (project: Project) => void;
}

const Ctx = createContext<StoreApi | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<StoreState>(initState);

  useEffect(() => bus.subscribe(() => setState((s) => syncFromBus(s))), []);

  const api = useMemo<StoreApi>(() => ({
    state,
    gate: (threshold) => MODE_ORDER[state.mode] >= MODE_ORDER[threshold],
    apply: (label, commands) => {
      try {
        bus.dispatch(label, commands);
      } catch (e) {
        if (e instanceof CommandValidationError) {
          console.warn(`[command-bus] rejected batch "${label}" — [${e.op}] ${e.message}`);
        } else {
          console.error("[command-bus] dispatch failed", e);
        }
      }
    },
    applySilent: (commands) => {
      try {
        bus.dispatchSilent(commands);
      } catch (e) {
        console.warn("[command-bus] silent dispatch rejected", e);
      }
    },
    snapshot: (label) => bus.snapshot(label),
    undo: () => bus.undo(),
    redo: () => bus.redo(),
    setMode: (mode) => {
      localStorage.setItem(MODE_KEY, mode);
      setState((s) => ({ ...s, mode }));
    },
    setWorkspaceView: (workspaceView) => {
      localStorage.setItem(VIEW_KEY, workspaceView);
      setState((s) => ({ ...s, workspaceView }));
    },
    setAiPanel: (aiPanelOpen) => {
      localStorage.setItem(AI_KEY, aiPanelOpen ? "1" : "0");
      setState((s) => ({ ...s, aiPanelOpen }));
    },
    selectTrack: (trackId) =>
      setState((s) => {
        const track = bus.getState().tracks.find((t) => t.id === trackId);
        if (!track) return s;
        return { ...s, selectedTrackId: trackId, editorClipId: track.sourceClipId };
      }),
    setEditorClip: (clipId) => setState((s) => ({ ...s, editorClipId: clipId })),
    toggleMixer: () => setState((s) => ({ ...s, mixerOpen: !s.mixerOpen })),
    loadProject: (project) => bus.replace(project),
  }), [state]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useStore(): StoreApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore outside StoreProvider");
  return ctx;
}
