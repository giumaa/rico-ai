// Message protocol between the main process (EngineHost) and the LLM utilityProcess (worker.ts).
// Plain JSON-serialisable objects only (utilityProcess.postMessage uses structured clone).

import type { PerfMode } from '../../shared/api';
import type { Turn } from '../persona';

export interface WorkerHardware {
  gpuType: 'cuda' | 'vulkan' | 'metal' | 'none';
  gpuName?: string;
  vramGB?: number;
  /** integrated GPU / Apple Silicon sharing system RAM */
  unified?: boolean;
  physicalCores?: number;
  logicalCores?: number;
}

export interface LoadParams {
  /** Absolute path of the .gguf (first shard for split models). */
  modelPath: string;
  perfMode: PerfMode;
  /** Context length requested by the catalog / default for imports. Capped by RAM and the model's training context. */
  requestedContext: number;
  totalRamGB: number;
  modelSizeGB: number;
  /** Optional catalog hint for the chat template ('qwen', 'chatml', 'gemma', 'llama3', ...). */
  chatTemplateHint?: string;
  /** Multimodal projector GGUF (vision models). Only the llama-server sidecar can use it. */
  mmprojPath?: string;
  /** Dedicated block count / training context if the caller already read the GGUF header. */
  blockCount?: number;
}

export type VisionIssue = 'blocked' | 'unavailable' | 'failed' | 'projector';

export interface LoadedInfo {
  contextSize: number;
  threads: number;
  gpuLayers: number | 'auto';
  gpu: WorkerHardware['gpuType'];
  trainContext?: number;
  wrapper?: string;
  /** true when the loaded engine can accept image input. */
  vision?: boolean;
  /** Why vision is unavailable although the model has a projector (main turns it into a localised message). */
  visionNote?: VisionIssue;
  /** Which engine runs the model. */
  engine?: 'llama-server' | 'node-llama-cpp';
}

export interface Sampling {
  temperature: number;
  maxTokens: number;
}

export type ToWorker =
  | { type: 'hardware'; id: number }
  | { type: 'load'; id: number; params: LoadParams }
  | { type: 'unload'; id: number }
  | { type: 'generate'; requestId: string; systemPrompt: string; turns: Turn[]; sampling: Sampling }
  | { type: 'abort'; requestId: string }
  | { type: 'shutdown' };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'hardware-result'; id: number; info: WorkerHardware }
  | { type: 'load-result'; id: number; ok: true; info: LoadedInfo }
  | { type: 'load-result'; id: number; ok: false; error: string; code?: 'oom' | 'bad-file' | 'other' }
  | { type: 'unload-result'; id: number }
  | { type: 'token'; requestId: string; chunk: string }
  | { type: 'done'; requestId: string; text: string; tokensPerSecond?: number; stopped: boolean }
  | { type: 'error'; requestId: string; message: string; code?: 'no-model' | 'busy' | 'other' };
