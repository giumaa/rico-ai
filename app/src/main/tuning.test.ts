import { describe, expect, it } from 'vitest';
import {
  effectiveMemoryGB,
  imageMaxTokensForContext,
  maxImageEdgeForContext,
  maxImagesForContext,
  perfProfile,
  pickContextSize,
  pickGpuName,
  pickVisionContextSize,
  recommendModelId,
  tierForMemory,
  type TierCandidate
} from './tuning';

const catalog: TierCandidate[] = [
  { id: 'rico-lite', sizeGB: 2.5, minRamGB: 8 },
  { id: 'rico', sizeGB: 9, minRamGB: 14 },
  { id: 'rico-max', sizeGB: 18.6, minRamGB: 28 }
];

const cpu = { gpuType: 'none' as const };

describe('tierForMemory', () => {
  it('uses the <12 / <28 / else thresholds from the spec', () => {
    expect(tierForMemory(4)).toBe('rico-lite');
    expect(tierForMemory(11.9)).toBe('rico-lite');
    expect(tierForMemory(12)).toBe('rico');
    expect(tierForMemory(27.9)).toBe('rico');
    expect(tierForMemory(28)).toBe('rico-max');
    expect(tierForMemory(128)).toBe('rico-max');
  });
});

describe('recommendModelId', () => {
  it('recommends by total RAM', () => {
    expect(recommendModelId({ totalRamGB: 7.8, ...cpu }, catalog)).toBe('rico-lite');
    expect(recommendModelId({ totalRamGB: 15.9, ...cpu }, catalog)).toBe('rico');
    expect(recommendModelId({ totalRamGB: 31.8, ...cpu }, catalog)).toBe('rico-max');
    expect(recommendModelId({ totalRamGB: 64, ...cpu }, catalog)).toBe('rico-max');
  });

  it('steps down to a smaller tier when the larger model does not fit', () => {
    const tight: TierCandidate[] = [
      { id: 'rico-lite', sizeGB: 2.5, minRamGB: 8 },
      { id: 'rico', sizeGB: 9, minRamGB: 20 },
      { id: 'rico-max', sizeGB: 18.6, minRamGB: 40 }
    ];
    expect(recommendModelId({ totalRamGB: 16, ...cpu }, tight)).toBe('rico-lite');
    expect(recommendModelId({ totalRamGB: 32, ...cpu }, tight)).toBe('rico');
  });

  it('compares GiB RAM with the nominal decimal-GB minRamGB (x1.07 + 0.5 slack)', () => {
    // 16 GB laptops report ~15.4 GiB: 15.4 * 1.07 + 0.5 = 16.98 >= 14 -> standard tier is fine
    expect(recommendModelId({ totalRamGB: 15.4, ...cpu }, catalog)).toBe('rico');
    // a "8 GB" machine with an iGPU carve-out (7.2 GiB) still gets the 8 GB tier (7.2 * 1.07 + 0.5 = 8.2)
    expect(recommendModelId({ totalRamGB: 7.2, ...cpu }, catalog)).toBe('rico-lite');
    // boundary: 12.6 GiB -> standard tier threshold passes, minRamGB 14 > 12.6 * 1.07 + 0.5 = 13.98 -> steps down
    expect(recommendModelId({ totalRamGB: 12.6, ...cpu }, catalog)).toBe('rico-lite');
    expect(recommendModelId({ totalRamGB: 12.7, ...cpu }, catalog)).toBe('rico');
  });

  it('falls back to the smallest model when nothing fits', () => {
    expect(recommendModelId({ totalRamGB: 4, ...cpu }, catalog)).toBe('rico-lite');
  });

  it('falls back to the tier id when the catalog is empty', () => {
    expect(recommendModelId({ totalRamGB: 16, ...cpu }, [])).toBe('rico');
  });

  it('works with catalogs that miss some tiers', () => {
    const onlyLite: TierCandidate[] = [{ id: 'rico-lite', sizeGB: 2.5, minRamGB: 8 }];
    expect(recommendModelId({ totalRamGB: 64, ...cpu }, onlyLite)).toBe('rico-lite');
  });

  it('lets a big discrete GPU raise the tier, but never beyond 2x RAM', () => {
    const gpu = { gpuType: 'cuda' as const, vramGB: 24, gpuUnified: false };
    expect(effectiveMemoryGB({ totalRamGB: 16, ...gpu })).toBe(28);
    expect(recommendModelId({ totalRamGB: 16, ...gpu }, catalog)).toBe('rico-max');
    // 8 GB RAM + 24 GB VRAM is capped at 16 GB effective
    expect(effectiveMemoryGB({ totalRamGB: 8, ...gpu })).toBe(16);
    expect(recommendModelId({ totalRamGB: 8, ...gpu }, catalog)).toBe('rico');
  });

  it('ignores integrated / unified GPUs and small cards', () => {
    expect(effectiveMemoryGB({ totalRamGB: 16, gpuType: 'vulkan', vramGB: 16, gpuUnified: true })).toBe(16);
    expect(effectiveMemoryGB({ totalRamGB: 16, gpuType: 'metal', vramGB: 16, gpuUnified: true })).toBe(16);
    expect(effectiveMemoryGB({ totalRamGB: 8, gpuType: 'vulkan', vramGB: 4, gpuUnified: false })).toBe(8);
  });
});

describe('pickContextSize', () => {
  it('caps the context by RAM and the catalog request', () => {
    expect(pickContextSize({ requested: 32768, totalRamGB: 8, modelSizeGB: 2.5 })).toBe(4096);
    expect(pickContextSize({ requested: 2048, totalRamGB: 32, modelSizeGB: 2.5 })).toBe(2048);
    expect(pickContextSize({ requested: 32768, totalRamGB: 32, modelSizeGB: 18 })).toBeLessThanOrEqual(32768);
  });

  it('never exceeds the model training context and is a multiple of 256', () => {
    const n = pickContextSize({ requested: 32768, totalRamGB: 64, modelSizeGB: 4, trainContext: 6000 });
    expect(n).toBeLessThanOrEqual(6000);
    expect(n % 256).toBe(0);
  });

  it('shrinks when the model leaves little free RAM but keeps a sane minimum', () => {
    const n = pickContextSize({ requested: 32768, totalRamGB: 16, modelSizeGB: 12 });
    expect(n).toBeGreaterThanOrEqual(1024);
    expect(n).toBeLessThan(8192);
  });
});

describe('perfProfile', () => {
  const base = { physicalCores: 8, logicalCores: 16, gpuType: 'none' as const, modelSizeGB: 2.5 };

  it('eco uses physicalCores - 2 threads (min 2) and a modest batch', () => {
    expect(perfProfile('eco', base).threads).toBe(6);
    expect(perfProfile('eco', { ...base, physicalCores: 2 }).threads).toBe(2);
    expect(perfProfile('eco', { ...base, physicalCores: 4 }).threads).toBe(2);
    expect(perfProfile('eco', base).batchSize).toBeLessThan(perfProfile('max', base).batchSize);
  });

  it('balanced = physicalCores - 1, max = all physical cores', () => {
    expect(perfProfile('balanced', base).threads).toBe(7);
    expect(perfProfile('max', base).threads).toBe(8);
  });

  it('never asks for more threads than the machine has', () => {
    expect(perfProfile('max', { ...base, physicalCores: 8, logicalCores: 4 }).threads).toBe(4);
  });

  it('uses no GPU layers without a GPU', () => {
    expect(perfProfile('max', base).gpuLayers).toBe(0);
  });

  it('is conservative on a <=4 GB discrete GPU in eco mode (fixed layer count)', () => {
    const gpu = { ...base, gpuType: 'vulkan' as const, gpuUnified: false, blockCount: 36, modelSizeGB: 2.5 };
    const p = perfProfile('eco', { ...gpu, vramGB: 4 });
    expect(typeof p.gpuLayers).toBe('number');
    // (4 GB * 0.5 - 0.5 GB reserve) / 2.5 GB = 0.6 -> 21 of 36 layers
    expect(p.gpuLayers).toBe(21);
    // a "4 GB" card that reports 4.35 GB is still a small card
    expect(typeof perfProfile('eco', { ...gpu, vramGB: 4.35 }).gpuLayers).toBe('number');
    // a 3 GB card gets even fewer layers, never a negative number
    expect(perfProfile('eco', { ...gpu, vramGB: 3 }).gpuLayers).toBe(14);
    expect(perfProfile('eco', { ...gpu, vramGB: 0.8 }).gpuLayers).toBe(0);
  });

  it('lets the library fit layers on larger cards, capped by dedicated VRAM', () => {
    const gpu = { ...base, gpuType: 'cuda' as const, gpuUnified: false };
    expect(perfProfile('eco', { ...gpu, vramGB: 8 }).gpuLayers).toBe('auto');
    expect(perfProfile('eco', { ...gpu, vramGB: 8 }).gpuLayersMax).toBeUndefined();
    // 4 GB card + 9 GB model in balanced mode: auto, but never more than the card can hold
    const big = perfProfile('balanced', { ...gpu, vramGB: 4, modelSizeGB: 9, blockCount: 40 });
    expect(big.gpuLayers).toBe('auto');
    expect(big.gpuLayersMax).toBe(Math.floor(40 * ((4 * 0.75 - 0.5) / 9)));
    // everything fits: no cap
    expect(perfProfile('max', { ...gpu, vramGB: 12, modelSizeGB: 2.5, blockCount: 36 }).gpuLayersMax).toBeUndefined();
  });

  it('keeps integrated Vulkan GPUs off in eco mode, Metal always on', () => {
    expect(perfProfile('eco', { ...base, gpuType: 'vulkan', vramGB: 8, gpuUnified: true }).gpuLayers).toBe(0);
    expect(perfProfile('eco', { ...base, gpuType: 'metal', vramGB: 12, gpuUnified: true }).gpuLayers).toBe('auto');
  });
});

describe('pickGpuName', () => {
  it('shows the discrete card when an integrated GPU is listed first', () => {
    expect(pickGpuName(['Intel(R) UHD Graphics 630', 'Quadro T2000'], false)).toBe('Quadro T2000');
    expect(pickGpuName(['NVIDIA GeForce RTX 4060'], false)).toBe('NVIDIA GeForce RTX 4060');
  });
  it('falls back to the first name for integrated-only machines', () => {
    expect(pickGpuName(['Intel(R) Iris(R) Xe Graphics'], true)).toBe('Intel(R) Iris(R) Xe Graphics');
    expect(pickGpuName([], false)).toBeUndefined();
  });
});

describe('vision limits for small context windows (review item 12)', () => {
  it('allows fewer images and smaller pictures when the window is small', () => {
    expect(maxImagesForContext(4096)).toBe(2);
    expect(maxImagesForContext(2048)).toBe(2);
    expect(maxImagesForContext(8192)).toBe(4);
    expect(maxImagesForContext(32768)).toBe(6);
    expect(maxImageEdgeForContext(4096)).toBe(896);
    expect(maxImageEdgeForContext(8192)).toBe(1280);
    expect(imageMaxTokensForContext(4096)).toBe(512);
    expect(imageMaxTokensForContext(8192)).toBe(512);
    expect(imageMaxTokensForContext(16384)).toBeUndefined();
  });

  it('gives vision models head-room for image tokens even on an 8 GB machine', () => {
    const small = { requested: 8192, totalRamGB: 7.8, modelSizeGB: 2.5 };
    expect(pickContextSize(small)).toBe(4096);
    expect(pickVisionContextSize(small)).toBe(4096);
    expect(pickVisionContextSize({ requested: 2048, totalRamGB: 4, modelSizeGB: 1 })).toBeGreaterThanOrEqual(2048);
    expect(maxImagesForContext(pickVisionContextSize(small))).toBe(2);
    expect(maxImagesForContext(pickVisionContextSize({ requested: 16384, totalRamGB: 32, modelSizeGB: 9 }))).toBe(6);
  });
});
