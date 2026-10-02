// Common shape of an inference backend (node-llama-cpp worker, llama-server sidecar) and of the router in front.

import type { ModelLoadState } from '../../shared/api';
import type { Turn } from '../persona';
import type { LoadedInfo, LoadParams, Sampling, WorkerHardware } from './protocol';

export interface GenerateHandlers {
  onToken(chunk: string): void;
  onDone(e: { text: string; tokensPerSecond?: number; stopped: boolean }): void;
  onError(e: { message: string; code?: 'no-model' | 'busy' | 'other' | 'crashed' | 'context' }): void;
}

export interface GenerateInput {
  systemPrompt: string;
  turns: Turn[];
  sampling: Sampling;
}

export interface Backend {
  load(modelId: string, params: LoadParams): Promise<LoadedInfo>;
  unload(): Promise<void>;
  generate(requestId: string, req: GenerateInput, handlers: GenerateHandlers): void;
  abort(requestId: string): void;
  hasActiveGeneration(): boolean;
  getLoadState(): ModelLoadState;
  getLoadedInfo(): LoadedInfo | undefined;
  onLoadState(cb: (s: ModelLoadState) => void): () => void;
  shutdown(): Promise<void>;
  /** Optional: free the process/memory while keeping the backend usable later (no "shutting down" state). */
  release?(): Promise<void>;
}

/** What the rest of the app talks to. */
export interface Engine extends Backend {
  /** GPU / core facts (cached). Rejects on failure; callers fall back to defaults. */
  hardware(timeoutMs?: number): Promise<WorkerHardware>;
}
