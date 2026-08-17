/* Audio-backend seam.
 *
 * UI components and the app layer talk ONLY to the AudioBackend interface —
 * never to AudioNodes, AudioContext, or a concrete engine. Today the backend
 * is the Web Audio engine (src/audio/engine.ts); when the desktop shell
 * arrives, a TauriBackend implementing this same interface can route
 * transport/preview/meter calls over IPC to a native (Rust/CPAL) engine
 * without touching a single component. */

import { Project } from "../types";
import { getEngine } from "../audio/engine";

export interface AudioVoice {
  stop(): void;
}

export interface AudioBackend {
  readonly kind: "webaudio" | "native";

  /* graph */
  setProject(p: Project): void;

  /* transport */
  play(): void;
  pause(): void;
  stop(): void;
  readonly playing: boolean;
  setLoop(loop: boolean): void;
  readonly loop: boolean;
  getCurrentStep(): number;
  setOnTransport(cb: ((playing: boolean) => void) | null): void;

  /* performance */
  previewNote(trackId: string, pitch: number, vel?: number, durSec?: number): AudioVoice;

  /* rendering */
  exportWav(p: Project): Promise<Blob>;

  /* metering / diagnostics */
  getTrackLevel(trackId: string): number;
  getMasterLevel(): number;
  getSpectrum(out: Uint8Array): void;
  getLoad(): number;
  getLatencyMs(): number;
}

class WebAudioBackend implements AudioBackend {
  readonly kind = "webaudio" as const;
  private get e() {
    return getEngine();
  }

  setProject(p: Project): void {
    this.e.setProject(p);
  }

  play(): void {
    this.e.play();
  }
  pause(): void {
    this.e.pause();
  }
  stop(): void {
    this.e.stop();
  }
  get playing(): boolean {
    return this.e.playing;
  }
  setLoop(loop: boolean): void {
    this.e.loop = loop;
  }
  get loop(): boolean {
    return this.e.loop;
  }
  getCurrentStep(): number {
    return this.e.getCurrentStep();
  }
  setOnTransport(cb: ((playing: boolean) => void) | null): void {
    this.e.onTransport = cb;
  }

  previewNote(trackId: string, pitch: number, vel = 0.85, durSec = 8): AudioVoice {
    return this.e.previewNote(trackId, pitch, vel, durSec);
  }

  exportWav(p: Project): Promise<Blob> {
    return this.e.exportWav(p);
  }

  getTrackLevel(trackId: string): number {
    return this.e.getTrackLevel(trackId);
  }
  getMasterLevel(): number {
    return this.e.getMasterLevel();
  }
  getSpectrum(out: Uint8Array): void {
    this.e.getSpectrum(out);
  }
  getLoad(): number {
    return this.e.getLoad();
  }
  getLatencyMs(): number {
    return this.e.getLatencyMs();
  }
}

/* Future:
 * class TauriBackend implements AudioBackend {
 *   readonly kind = "native" as const;
 *   // transport & preview commands → invoke("plugin:audio|play", …)
 *   // metering ← event channel from the Rust engine, throttled to ~30 Hz
 * }
 */

/** The backend every UI component talks to. */
export const audio: AudioBackend = new WebAudioBackend();
