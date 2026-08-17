# Cadence — Open-Source AI DAW

A free, open-source digital audio workstation built for **beginners** that scales into
professional workflows. Cadence runs entirely in the browser on the Web Audio API —
no account, no cloud, no GPU required.

> Make professional music production understandable to beginners, while allowing the
> application to scale into a professional DAW.

## Why Cadence is different

1. **Beginner-first UX** — three progressive modes (Beginner → Producer → Advanced)
   hide complexity until it's useful. Nothing is removed, only disclosed.
2. **AI-native, not AI-bolted-on** — the copilot is a scoped *music-content* copilot:
   it runs in its own sandboxed worker and emits **validated MIDI commands**
   (`create_clip`, `set_tempo`, `transpose_clip`, …) — never mixer moves, never files,
   never network. It shows the plan, and only the shared command executor mutates the
   project. Every AI batch is a single atomic undo entry.
3. **Low-hardware by design** — all sound is code-synthesized (zero sample downloads),
   the scheduler only queues native WebAudio nodes, and the AI is deterministic
   generation (seeded music-theory algorithms), so idle CPU/GPU cost is ~0.

## Getting started

```bash
npm install
npm run dev       # local dev server
npm run build     # production build (dist/)
```

Open the app, press **play** — a generated demo song ("First Light") is already loaded.
Then try the copilot: *"make a beat"*, *"add a melody"*, *"more energy"*,
*"change key to C minor"*, *"arrange my song"*.

**Keyboard**: `Space` play/pause · `A W S E D F T G Y H U J K` live piano (records when
the red button is armed) · `Z X C V B` drum pads · `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo.

## Architecture

```
AI copilot ──▶ Intent parser ──▶ DawCommand[] ──▶ validated executor ──▶ Project state
     (never mutates state)            │                    │                  │
                                      └── user gestures use the same path ───┘
                                                           │
                                                      undo/redo stack (snapshots)
                                                           │
                                   audio engine (lookahead scheduler, 25 ms tick)
                                                           │
                        per-track graph: filter → drive → pan → gain → analyser → master
                                         └ delay send ┘   └ shared convolver reverb bus ┘
```

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Domain model: Project / Track / Clip / Note / DawCommand |
| `src/theory.ts` | Scales, chords, seeded pattern generators (drums, bass, chords, melody) |
| `src/audio/synth.ts` | Code-synthesized voices + drum synthesis + WAV encoder |
| `src/audio/engine.ts` | Real-time scheduler, track graphs, meters, offline WAV render |
| `src/ai/commands.ts` | The **only** mutation gateway (pure executors + factories) |
| `src/ai/intent.ts` | Deterministic MIDI-only intent parser → validated command plans |
| `src/ai/aiWorker.ts` | AI process sandbox — the parser runs in a DOM-less Web Worker |
| `src/state/validate.ts` | Schema validation/sanitization for every project that is loaded |
| `src/state/store.tsx` | Reducer, shared undo/redo, UX modes, selection |
| `src/components/*` | Transport, Timeline, Step Sequencer, Piano Roll, Mixer, Copilot |

Design rules: no heavy work on the audio path, no direct state mutation outside the
executor, no blocking of the UI thread, graceful degradation when storage is unavailable.

## Security

Security is a design constraint, not a final pass:

- **Renderer sandbox** — a strict `Content-Security-Policy` ships in `index.html`:
  no inline scripts, no `eval`, `object-src 'none'`, `connect-src 'none'`
  (app code makes **zero** network calls), `form-action 'none'`. The only declared
  external asset is Google Fonts; the desktop shell drops even that (see Shipping).
- **AI process sandbox** — the copilot executes in a dedicated **module Web Worker**
  (`src/ai/aiWorker.ts`). Module workers have no `document`, no `window`, no network
  or filesystem APIs; the parser's only imports are pure functions over the project
  model. It returns `DawCommand[]` — it cannot mutate anything by construction.
  A 1.6 s failsafe falls back to the same pure function inline if workers are
  unavailable; behavior is identical either way.
- **Every file is validated** — autosave restore *and* file import pass through
  `validateProject()`, which rebuilds a sanitized project from scratch: enum
  allow-lists (instruments, scales), ID/color format checks, range clamps
  (BPM 55–200, pitch, velocity, bars), size caps (tracks, clips, notes), and an
  8 MB input cap. A tampered or version-skewed save can never reach the engine raw.
- **Command layer** — user gestures and AI alike flow through one executor with
  schema-shaped operations and an atomic undo stack; there is no other write path.
- **No undisclosed network calls** — `connect-src 'none'` is enforced by the
  browser, not by convention; there is no telemetry, no updater phone-home,
  no analytics. Projects live in origin-scoped `localStorage` or in files you save.

## Shipping (one-click install)

The web build is installable today: the PWA manifest lets Chrome/Edge offer
*"Install Cadence"* with zero setup. For the native ship target — signed,
one-click `.exe` / `.dmg` / `.deb` / `AppImage` installers that behave like
Chrome's — the plan is a [Tauri](https://tauri.app) shell around this same web
codebase:

- **Why Tauri**: ~5 MB installer and ~30 MB RAM vs Electron's ~150 MB+; it uses
  the OS webview, needs **no GPU**, and its build pipeline signs and notarizes
  per platform (Authenticode on Windows, notarization on macOS).
- **Hardening carried over**: the shell disables the webview's devtools in
  release, sets the same CSP via Tauri config (with `unsafe-inline` removed
  entirely), disables external navigation, and bundles fonts so the desktop app
  is 100% offline.
- **Update flow**: Tauri's updater with signature verification, pointed at our
  release endpoint — signed manifests only, no unsigned downloads.

Commands for maintainers: `npm run tauri dev`, `npm run tauri build` (produces
all four installer formats per OS from one codebase).

## Roadmap

Phase done: shell + project system, audio engine + transport, timeline, MIDI editing,
mixer + DSP, built-in instruments, AI command architecture, AI MIDI/arrange copilot,
progressive UX modes. Next: audio clip recording, MIDI I/O, automation lanes,
plugin host (CLAP/WASM), project templates.

## Contributing

Issues and PRs welcome. Keep changes command-based (UI and AI alike), keep the audio
thread allocation-free, and add generators to `theory.ts` rather than hard-coding
patterns. Code of Conduct: be kind, assume good faith, review the code not the author.

## License

MIT — see [LICENSE](LICENSE). All sounds are synthesized in code; no third-party samples.
