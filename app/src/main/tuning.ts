// Pure hardware-tuning logic: model-tier recommendation, context-size capping and performance profiles.
// No Electron / node-llama-cpp imports here so it can be unit-tested directly.

import type { PerfMode } from '../shared/api';

export type GpuKind = 'cuda' | 'vulkan' | 'metal' | 'none';

export interface HardwareFacts {
  totalRamGB: number;
  physicalCores: number;
  gpuType: GpuKind;
  /** Dedicated or unified GPU memory in GB (if known). */
  vramGB?: number;
  /** Integrated GPU / Apple Silicon sharing system RAM. */
  gpuUnified?: boolean;
}

export interface TierCandidate {
  id: string;
  sizeGB: number;
  minRamGB: number;
}

export const TIER_ORDER = ['rico-lite', 'rico', 'rico-max'] as const;

/** Memory that realistically backs the model: system RAM, or RAM+VRAM for a big discrete GPU (capped). */
export function effectiveMemoryGB(hw: Pick<HardwareFacts, 'totalRamGB' | 'vramGB' | 'gpuType' | 'gpuUnified'>): number {
  const ram = Math.max(0, hw.totalRamGB);
  const vram = hw.vramGB ?? 0;
  const discrete = (hw.gpuType === 'cuda' || hw.gpuType === 'vulkan') && !hw.gpuUnified && vram >= 8;
  if (!discrete) return ram;
  // A discrete GPU with lots of VRAM can host a bigger model than the RAM suggests, but never trust it blindly.
  return Math.max(ram, Math.min(ram * 2, vram + 4));
}

/** Threshold tier for a given amount of memory: <12 GB -> lite, <28 GB -> standard, else max. */
export function tierForMemory(memGB: number): (typeof TIER_ORDER)[number] {
  if (memGB < 12) return 'rico-lite';
  if (memGB < 28) return 'rico';
  return 'rico-max';
}

/**
 * Picks the catalog model to recommend. Starts from the RAM(+VRAM) tier and steps DOWN while the tier's
 * model does not fit (minRamGB > totalRamGiB * 1.07 + 0.5). Falls back to the smallest catalog model.
 */
export function recommendModelId(
  hw: Pick<HardwareFacts, 'totalRamGB' | 'vramGB' | 'gpuType' | 'gpuUnified'>,
  catalog: readonly TierCandidate[]
): string {
  const mem = effectiveMemoryGB(hw);
  const startTier = tierForMemory(mem);
  if (catalog.length === 0) return startTier;

  const byId = new Map(catalog.map((m) => [m.id, m]));
  // os.totalmem() is in GiB (and a "16 GB" laptop reports ~15.4), catalog minRamGB is nominal decimal GB: compare fairly.
  const fits = (m: TierCandidate): boolean => m.minRamGB <= mem * 1.07 + 0.5;
  let idx = TIER_ORDER.indexOf(startTier);
  for (; idx >= 0; idx--) {
    const m = byId.get(TIER_ORDER[idx]!);
    if (m && fits(m)) return m.id;
  }

  // Catalog has no known tier ids that fit: choose the biggest catalog model that fits, else the smallest overall.
  const fitting = catalog.filter(fits).sort((a, b) => b.sizeGB - a.sizeGB);
  if (fitting[0]) return fitting[0].id;
  return [...catalog].sort((a, b) => a.sizeGB - b.sizeGB)[0]!.id;
}

// ---------------------------------------------------------------------------------------------------------
// Context size

const KV_GB_PER_TOKEN = 0.00018; // ~180 KB / token: typical for 4-14B GQA models with an f16 KV cache.

function ramContextCap(totalRamGB: number): number {
  if (totalRamGB <= 6) return 2048;
  if (totalRamGB <= 8.5) return 4096;
  if (totalRamGB <= 12.5) return 8192;
  if (totalRamGB <= 20) return 16384;
  return 32768;
}

export interface ContextSizeInput {
  /** contextLength from the catalog (or a default for imported models). */
  requested: number;
  totalRamGB: number;
  modelSizeGB: number;
  /** Context length the model was trained with, when known. */
  trainContext?: number;
}

/** Context window to ask node-llama-cpp for (it can still shrink it further to fit memory). */
export function pickContextSize(i: ContextSizeInput): number {
  const memCap = Math.floor((i.totalRamGB * 0.8 - i.modelSizeGB - 1.5) / KV_GB_PER_TOKEN);
  let size = Math.min(i.requested > 0 ? i.requested : 8192, ramContextCap(i.totalRamGB));
  if (Number.isFinite(memCap)) size = Math.min(size, Math.max(memCap, 2048));
  if (i.trainContext && i.trainContext > 0) size = Math.min(size, i.trainContext);
  size = Math.floor(size / 256) * 256;
  return Math.max(1024, size);
}

/** Vision models get head-room for image tokens even on small machines (each image costs ~1000 tokens). */
export function pickVisionContextSize(i: ContextSizeInput): number {
  const base = pickContextSize(i);
  return Math.max(base, Math.min(4096, i.requested > 0 ? i.requested : 4096));
}

/** Images accepted per message: 4 images x ~1200 tokens would overflow a 4096-token window. */
export function maxImagesForContext(contextSize: number): number {
  if (contextSize <= 4096) return 2;
  if (contextSize <= 8192) return 4;
  return 6;
}

/** Long edge (px) the renderer should downscale images to for this window. */
export function maxImageEdgeForContext(contextSize: number): number {
  return contextSize <= 4096 ? 896 : 1280;
}

/** "--image-max-tokens" (supported by the pinned llama-server build; dynamic-resolution vision models) for windows <= 8192; undefined = model default. */
export function imageMaxTokensForContext(contextSize: number): number | undefined {
  return contextSize <= 8192 ? 512 : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Performance profile

export interface PerfProfile {
  threads: number;
  batchSize: number;
  /** 0 = CPU only, a number = exactly that many layers on the GPU, 'auto' = let node-llama-cpp fit as many as it can. */
  gpuLayers: 'auto' | number;
  /** Upper bound for 'auto' (derived from DEDICATED VRAM, because shared/unified memory can mislead the auto-fit). */
  gpuLayersMax?: number;
}

export interface PerfInput {
  physicalCores: number;
  logicalCores?: number;
  gpuType: GpuKind;
  /** Dedicated VRAM in GB for a discrete GPU; shared memory for an integrated one. */
  vramGB?: number;
  /** Integrated GPU / Apple Silicon only (no dedicated GPU memory). */
  gpuUnified?: boolean;
  /** GGUF file size (all shards) in GB. */
  modelSizeGB: number;
  /** Number of transformer blocks, if known (from GGUF metadata). */
  blockCount?: number;
}

/** Cards reporting up to this much are "<= 4 GB" cards (a 4 GB card reports ~4.0-4.4 GB). */
export const SMALL_VRAM_GB = 4.5;

export function perfProfile(mode: PerfMode, i: PerfInput): PerfProfile {
  const phys = Math.max(1, Math.floor(i.physicalCores || 1));
  const maxThreads = Math.max(1, Math.floor(i.logicalCores ?? phys * 2));
  let threads: number;
  let batchSize: number;
  switch (mode) {
    case 'eco':
      threads = Math.max(2, phys - 2);
      batchSize = 256;
      break;
    case 'balanced':
      threads = Math.max(2, phys - 1);
      batchSize = 512;
      break;
    case 'max':
      threads = phys;
      batchSize = 1024;
      break;
  }
  threads = Math.max(1, Math.min(threads, maxThreads));

  return { threads, batchSize, ...gpuPlan(mode, i) };
}

const VRAM_USE_FRACTION: Record<PerfMode, number> = { eco: 0.5, balanced: 0.75, max: 0.9 };
const GPU_COMPUTE_RESERVE_GB = 0.5;

function gpuPlan(mode: PerfMode, i: PerfInput): Pick<PerfProfile, 'gpuLayers' | 'gpuLayersMax'> {
  if (i.gpuType === 'none') return { gpuLayers: 0 };
  if (i.gpuType === 'metal') return { gpuLayers: 'auto' }; // Apple Silicon: full offload is both fastest and cheapest.

  // Integrated Vulkan GPUs share RAM bandwidth with the CPU and are flaky on some drivers: eco stays on the CPU.
  if (i.gpuUnified) return mode === 'eco' ? { gpuLayers: 0 } : { gpuLayers: 'auto' };

  const vram = i.vramGB ?? 0;
  if (vram <= 0) return { gpuLayers: 'auto' };

  const blocks = i.blockCount && i.blockCount > 0 ? i.blockCount : undefined;
  const usableGB = Math.max(0, vram * VRAM_USE_FRACTION[mode] - GPU_COMPUTE_RESERVE_GB);
  const ratio = usableGB / Math.max(0.5, i.modelSizeGB);
  const cap = blocks ? Math.floor(blocks * Math.min(1, ratio)) : undefined;

  // Small card in eco mode: use a fixed, conservative number of layers so the desktop keeps its GPU memory.
  if (mode === 'eco' && vram <= SMALL_VRAM_GB) return { gpuLayers: cap ?? Math.floor(16 * Math.min(1, ratio)) };
  // Otherwise let node-llama-cpp fit, but never beyond what the dedicated VRAM can hold.
  if (cap !== undefined && ratio < 1) return { gpuLayers: 'auto', gpuLayersMax: cap };
  return { gpuLayers: 'auto' };
}

const INTEGRATED_GPU_RE = /intel|uhd|iris|hd graphics|llvmpipe|swiftshader|microsoft basic|apple/i;

/** Picks the most meaningful GPU name to show: the discrete card when an integrated GPU is listed first. */
export function pickGpuName(names: readonly string[], integratedOnly: boolean): string | undefined {
  if (names.length === 0) return undefined;
  if (integratedOnly) return names[0];
  return names.find((n) => !INTEGRATED_GPU_RE.test(n)) ?? names[0];
}
