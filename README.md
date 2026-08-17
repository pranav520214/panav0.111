# Cadence — Open-Source AI DAW

A free, open-source digital audio workstation built for **beginners** that scales into
professional workflows. Cadence runs entirely in the browser on the Web Audio API —
no account, no cloud, no GPU required.

> Make professional music production understandable to beginners, while allowing the
> application to scale into a professional DAW.

## Why Cadence is different

1. **Beginner-first UX** — three progressive modes (Beginner → Producer → Advanced)
   hide complexity until it's useful. Nothing is removed, only disclosed.
2. **AI-native, not AI-bolted-on** — the copilot never touches state directly. It parses
   intent into **validated DAW commands** (`set_track_volume`, `create_clip`, …), shows the
   plan, and only the shared command executor mutates the project. Every AI batch is a
   single atomic undo entry.
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
*"arrange my song"*, *"fix my mix"*, *"what is a compressor?"*.

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
| `src/ai/intent.ts` | Deterministic intent → command plans, mix analysis, glossary |
| `src/state/store.tsx` | Reducer, shared undo/redo, UX modes, selection |
| `src/components/*` | Transport, Timeline, Step Sequencer, Piano Roll, Mixer, Copilot |

Design rules: no heavy work on the audio path, no direct state mutation outside the
executor, no blocking of the UI thread, graceful degradation when storage is unavailable.

## Roadmap

Phase done: shell + project system, audio engine + transport, timeline, MIDI editing,
mixer + DSP, built-in instruments, AI command architecture, AI producer/MIDI/arrange/mix,
progressive UX modes. Next: audio clip recording, MIDI I/O, automation lanes,
plugin host (CLAP/WASM), project templates.

## Contributing

Issues and PRs welcome. Keep changes command-based (UI and AI alike), keep the audio
thread allocation-free, and add generators to `theory.ts` rather than hard-coding
patterns. Code of Conduct: be kind, assume good faith, review the code not the author.

## License

MIT — see [LICENSE](LICENSE). All sounds are synthesized in code; no third-party samples.
