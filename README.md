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

Three strict layers; dependencies point one way (UI → state → core; core → audio
through a seam, never the reverse):

```
src/
├── core/                     # APPLICATION LAYER — framework-free, DOM-free
│   ├── commands.ts           # Command vocabulary (named ops) + schema validation + metadata
│   ├── executors.ts          # pure executors: (Project, Command) → Project — never throw
│   ├── bus.ts                # CommandBus: dispatch → validate → execute → snapshot → notify
│   ├── audio.ts              # AudioBackend seam (WebAudio today, Tauri/native later)
│   ├── validate.ts           # schema validation/sanitization for every loaded project
│   ├── format.ts             # versioned .open-daw.json format + migration registry
│   ├── format.test.ts        # unit tests: round-trip deep equality, migrations, errors
│   ├── seed.ts               # generated demo + starter projects
│   └── index.ts              # barrel
├── state/store.tsx           # UI STATE LAYER — React binding that mirrors the bus
├── audio/                    # AUDIO ENGINE LAYER — real-time scheduler, DSP, WAV render
│   ├── engine.ts             #   (reached only via the core/audio seam)
│   └── synth.ts              # code-synthesized voices, drum synthesis, WAV encoder
├── ai/                       # AI LAYER — sandboxed worker → Command[] → the same bus
│   ├── intent.ts             # deterministic MIDI-only intent parser
│   └── aiWorker.ts           # DOM-less Web Worker sandbox
├── components/               # UI LAYER — talks to the store + audio seam, never AudioNodes
└── theory.ts / types.ts      # shared domain model + music theory
```

### The command bus

Every mutation — a fader drag, a step-sequencer click, an AI plan, a file import —
is a discrete, named `Command` applied through **one** function:

```
dispatch(label, commands)
  1. schema-validate every command        ← one bad command rejects the whole batch
  2. run pure executors:  before → after  ← (Project, Command) → Project, no side effects
  3. push { label, before, commands }     ← the undo entry
  4. notify subscribers                   ← React bindings, engine sync, autosave
```

Undo restores the stored pre-state snapshot; redo **replays the stored commands
through the same executors**, so there is exactly one code path in both directions.
`dispatchSilent()` (live note recording) and `snapshot()` (take checkpoints) ride
the same pipeline. History is capped at 64 atomic batches; user edits and AI edits
share one stack, so *Ctrl+Z reverts an AI plan exactly like a manual edit*.

### The audio seam

No UI component touches an `AudioNode` or the engine singleton — everything goes
through the `AudioBackend` interface (`src/core/audio.ts`): transport, preview,
metering, WAV export. Today a `WebAudioBackend` adapts the Web Audio engine; when
the desktop shell lands, a `TauriBackend` implementing the same interface routes
those calls over IPC to a native engine without touching a single component.

Design rules: no heavy work on the audio path, no state mutation outside the bus,
no UI → engine coupling outside the seam, graceful degradation when storage or
workers are unavailable.

## Project file format

`.open-daw.json` — versioned JSON, defined and implemented in `src/core/format.ts`.

```jsonc
{
  "format": "open-daw",          // constant magic
  "version": 1,                  // integer; bumped on breaking changes
  "metadata": { "name": "…", "created": "ISO-8601", "modified": "ISO-8601" },
  "tempo": { "bpm": 120 },
  "timeSignature": { "numerator": 4, "denominator": 4 },
  "lengthBars": 16,
  "key": { "rootMidi": 57, "scale": "minor" },
  "tracks":  [ { "id", "name", "color", "instrumentId", "volume", "pan",
                 "mute", "solo", "clipIds", "sourceClipId", "placements[]" } ],
  "clips":   [ { "id", "name", "lengthBars", "notes[]" } ],
  "instruments": [ { "id", "kind", "name", "presetId" } ],   // tracks link by id
  "effects": [ { "id", "trackId", "type": "channel-strip", "params" } ],
  "automation": [ { "id", "trackId", "param", "points[]" } ],
  "routing": { "outputs": […], "assignments": […] },
  "samples": [],                 // reserved — all sound is code-synthesized
  "presets": []                  // reserved — user presets
}
```

- `serialize(project) → string` is a **pure function of state** (timestamps
  included), so save-then-reload is lossless and deep-equal.
- `deserialize(json) → { ok, project } | { ok: false, error }` never throws.
  Malformed envelopes fail **field-by-field with a clear message**
  (`"tempo.bpm: must be a number"`); files from a future version are rejected
  with an explicit *"saved by a newer version — update the app"* error.
- **Migration registry** (`MIGRATIONS`): files older than the current version
  are walked forward step by step (`v0 → v1 → …`). The registry already
  upgrades both legacy save shapes this app shipped (raw-Project autosaves and
  the early `cadence` wrapper), so no user's work breaks on update. Autosave
  uses the same format, so the registry protects local saves too.
- Every load path (file import **and** autosave restore) ends in the shared
  sanitizer (`validateProject`): allow-lists, clamps and size caps apply even
  to structurally valid files.

## Tests

```bash
npx vitest run          # unit tests (format round-trip, migrations, errors)
npm run typecheck       # strict TS across the repo
npm run build           # production bundle
```

`src/core/format.test.ts` saves then reloads projects — empty, demo, and
automation-bearing — and asserts **deep equality**, alongside envelope,
future-version, malformed-input and migration-registry cases.

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
