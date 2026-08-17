/* Project store — user edits and AI edits share ONE undo/redo stack.
 * Mutations only happen through execCommands; the reducer never invents state. */

import React, { createContext, useContext, useMemo, useReducer } from "react";
import { DawCommand, Mode, Project } from "../types";
import { execCommands } from "../ai/commands";
import { buildDemoProject } from "./seed";
import { validateProject } from "./validate";

interface HistoryEntry { label: string; project: Project; }

export interface StoreState {
  project: Project;
  past: HistoryEntry[];
  future: HistoryEntry[];
  mode: Mode;
  selectedTrackId: string;
  editorClipId: string | null;
  mixerOpen: boolean;
}

type Action =
  | { type: "APPLY"; label: string; project: Project }
  | { type: "APPLY_SILENT"; project: Project }
  | { type: "SNAPSHOT"; label: string }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "SET_MODE"; mode: Mode }
  | { type: "SELECT_TRACK"; trackId: string }
  | { type: "SET_EDITOR_CLIP"; clipId: string }
  | { type: "TOGGLE_MIXER" }
  | { type: "LOAD"; project: Project };

const HISTORY_CAP = 64;

function loadInitialProject(): Project {
  try {
    const raw = localStorage.getItem("cadence.project.v1");
    if (raw) {
      // never trust stored JSON — full schema validation before it touches anything
      const res = validateProject(JSON.parse(raw));
      if (res.ok) return res.project;
      console.warn(`Cadence: stored project failed validation (${res.error}); loading demo song.`);
    }
  } catch { /* corrupted save — fall back to the demo song */ }
  return buildDemoProject();
}

function initState(): StoreState {
  const project = loadInitialProject();
  const rawMode = localStorage.getItem("cadence.mode");
  return {
    project,
    past: [],
    future: [],
    mode: rawMode === "producer" || rawMode === "advanced" ? rawMode : "beginner",
    selectedTrackId: project.tracks[0].id,
    editorClipId: project.tracks[0].sourceClipId,
    mixerOpen: true,
  };
}

function reducer(state: StoreState, action: Action): StoreState {
  switch (action.type) {
    case "APPLY":
      return {
        ...state,
        past: [...state.past.slice(-HISTORY_CAP + 1), { label: action.label, project: state.project }],
        future: [],
        project: action.project,
      };
    case "APPLY_SILENT":
      return { ...state, project: action.project };
    case "SNAPSHOT":
      return {
        ...state,
        past: [...state.past.slice(-HISTORY_CAP + 1), { label: action.label, project: state.project }],
        future: [],
      };
    case "UNDO": {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return {
        ...state,
        past: state.past.slice(0, -1),
        future: [...state.future, { label: prev.label, project: state.project }],
        project: prev.project,
        selectedTrackId: prev.project.tracks.some((t) => t.id === state.selectedTrackId)
          ? state.selectedTrackId
          : prev.project.tracks[0].id,
        editorClipId: null,
      };
    }
    case "REDO": {
      if (state.future.length === 0) return state;
      const next = state.future[state.future.length - 1];
      return {
        ...state,
        future: state.future.slice(0, -1),
        past: [...state.past, { label: next.label, project: state.project }],
        project: next.project,
        selectedTrackId: next.project.tracks.some((t) => t.id === state.selectedTrackId)
          ? state.selectedTrackId
          : next.project.tracks[0].id,
        editorClipId: null,
      };
    }
    case "SET_MODE":
      return { ...state, mode: action.mode };
    case "SELECT_TRACK": {
      const track = state.project.tracks.find((t) => t.id === action.trackId);
      if (!track) return state;
      return { ...state, selectedTrackId: action.trackId, editorClipId: track.sourceClipId };
    }
    case "SET_EDITOR_CLIP":
      return { ...state, editorClipId: action.clipId };
    case "TOGGLE_MIXER":
      return { ...state, mixerOpen: !state.mixerOpen };
    case "LOAD": {
      const p = action.project;
      return {
        ...state,
        past: [...state.past.slice(-HISTORY_CAP + 1), { label: "Load project", project: state.project }],
        future: [],
        project: p,
        selectedTrackId: p.tracks[0].id,
        editorClipId: p.tracks[0].sourceClipId,
      };
    }
    default:
      return state;
  }
}

export interface StoreApi {
  state: StoreState;
  /** Run commands through the executor; snapshot before → undoable. */
  apply: (label: string, commands: DawCommand[]) => void;
  /** Same pipeline, no history entry (used while live-recording notes). */
  applySilent: (commands: DawCommand[]) => void;
  snapshot: (label: string) => void;
  undo: () => void;
  redo: () => void;
  setMode: (mode: Mode) => void;
  selectTrack: (trackId: string) => void;
  setEditorClip: (clipId: string) => void;
  toggleMixer: () => void;
  loadProject: (project: Project) => void;
}

const Ctx = createContext<StoreApi | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initState);

  const api = useMemo<StoreApi>(() => ({
    state,
    apply: (label, commands) => {
      if (commands.length === 0) return;
      dispatch({ type: "APPLY", label, project: execCommands(state.project, commands) });
    },
    applySilent: (commands) => {
      if (commands.length === 0) return;
      dispatch({ type: "APPLY_SILENT", project: execCommands(state.project, commands) });
    },
    snapshot: (label) => dispatch({ type: "SNAPSHOT", label }),
    undo: () => dispatch({ type: "UNDO" }),
    redo: () => dispatch({ type: "REDO" }),
    setMode: (mode) => {
      localStorage.setItem("cadence.mode", mode);
      dispatch({ type: "SET_MODE", mode });
    },
    selectTrack: (trackId) => dispatch({ type: "SELECT_TRACK", trackId }),
    setEditorClip: (clipId) => dispatch({ type: "SET_EDITOR_CLIP", clipId }),
    toggleMixer: () => dispatch({ type: "TOGGLE_MIXER" }),
    loadProject: (project) => dispatch({ type: "LOAD", project }),
  }), [state]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useStore(): StoreApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore outside StoreProvider");
  return ctx;
}
