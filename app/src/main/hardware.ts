// System information for the UI + model recommendation. GPU/physical-core facts come from the engine worker
// (node-llama-cpp), everything else from Node's os module.

import { cpus, freemem, totalmem } from 'node:os';
import type { SystemInfo } from '../shared/api';
import type { Catalog } from './catalog';
import type { WorkerHardware } from './engine/protocol';
import { recommendModelId } from './tuning';

const GiB = 1024 ** 3;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Best-effort physical core count when the engine could not tell us (SMT is assumed on x86). */
export function guessPhysicalCores(logical: number, arch: string): number {
  if (arch === 'arm64') return Math.max(1, logical); // Apple Silicon / ARM: no SMT
  return Math.max(1, Math.floor(logical / 2));
}

export function buildSystemInfo(opts: {
  hw: WorkerHardware | null;
  catalog: Catalog;
  appVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): SystemInfo {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const cpuList = cpus();
  const logical = cpuList.length || 1;
  const totalRamGB = round1(totalmem() / GiB);
  const hw = opts.hw;
  const gpuType = hw?.gpuType ?? 'none';

  const gpu: SystemInfo['gpu'] = { type: gpuType };
  if (hw?.gpuName) gpu.name = hw.gpuName;
  if (hw?.vramGB !== undefined) gpu.vramGB = hw.vramGB;
  if (hw?.unified !== undefined) gpu.unified = hw.unified;

  return {
    platform,
    arch,
    totalRamGB,
    freeRamGB: round1(freemem() / GiB),
    cpuModel: (cpuList[0]?.model ?? 'Unknown CPU').replace(/\s+/g, ' ').trim(),
    physicalCores: hw?.physicalCores ?? guessPhysicalCores(logical, arch),
    gpu,
    recommendedModelId: recommendModelId(
      { totalRamGB, vramGB: hw?.vramGB, gpuType, gpuUnified: hw?.unified },
      opts.catalog.models
    ),
    appVersion: opts.appVersion
  };
}
