import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build tool without type declarations
import { shouldKeep } from './fetch-llama-server.mjs';

describe('fetch-llama-server prune rules', () => {
  const keep = (n: string, exe = 'llama-server.exe'): boolean => shouldKeep(n, exe);

  it('keeps the server and the libraries it loads', () => {
    for (const n of ['llama-server.exe', 'llama-server-impl.dll', 'llama.dll', 'llama-common.dll', 'mtmd.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-vulkan.dll', 'ggml-cpu-haswell.dll', 'libomp.dll', 'LICENSE-LLVM-OpenMP']) {
      expect(keep(n), n).toBe(true);
    }
    expect(shouldKeep('llama-server', 'llama-server')).toBe(true);
    expect(shouldKeep('libllama.so', 'llama-server')).toBe(true);
    expect(shouldKeep('libmtmd.dylib', 'llama-server')).toBe(true);
  });

  it('drops other tools, their implementation libraries, and the RPC (network) backend', () => {
    for (const n of ['llama.exe', 'ggml-rpc-server.exe', 'ggml-rpc.dll', 'llama-cli-impl.dll', 'llama-bench-impl.dll', 'llama-batched-bench-impl.dll', 'llama-completion-impl.dll', 'llama-fit-params-impl.dll', 'llama-perplexity-impl.dll', 'llama-quantize-impl.dll', 'test-backend-ops.exe']) {
      expect(keep(n), n).toBe(false);
    }
    expect(shouldKeep('llama-cli', 'llama-server')).toBe(false);
    expect(shouldKeep('llama-quantize', 'llama-server')).toBe(false);
    expect(shouldKeep('libggml-rpc.so', 'llama-server')).toBe(false);
  });
});
