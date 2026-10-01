import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { killStaleSidecar, parsePid } from './staleProcess';

let dir: string;
let pidFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rico-stale-'));
  pidFile = join(dir, 'engine.pid');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parsePid', () => {
  it('accepts positive integers only', () => {
    expect(parsePid('1234\n')).toBe(1234);
    for (const bad of ['', 'abc', '-5', '0', '1', '12.5']) expect(parsePid(bad)).toBeNull();
  });
});

describe('killStaleSidecar', () => {
  it('kills the recorded PID only when it really is llama-server, then removes the pid file', async () => {
    await writeFile(pidFile, '4242');
    const killed: number[] = [];
    const ran: string[][] = [];
    const ok = await killStaleSidecar(pidFile, {
      platform: 'win32',
      run: async (cmd, args) => {
        ran.push([cmd, ...args]);
        return '"llama-server.exe","4242","Console","1","1,234 K"';
      },
      kill: (pid) => killed.push(pid)
    });
    expect(ok).toBe(true);
    expect(killed).toEqual([4242]);
    expect(ran[0]![0]).toBe('tasklist');
    await expect(readFile(pidFile)).rejects.toThrow();
  });

  it('never kills a reused PID that belongs to another program', async () => {
    await writeFile(pidFile, '4242');
    const killed: number[] = [];
    const ok = await killStaleSidecar(pidFile, { platform: 'linux', run: async () => 'chrome\n', kill: (p) => killed.push(p) });
    expect(ok).toBe(false);
    expect(killed).toEqual([]);
    await expect(readFile(pidFile)).rejects.toThrow();
  });

  it('is a no-op without a pid file or with a corrupt one', async () => {
    expect(await killStaleSidecar(pidFile, { run: async () => '' })).toBe(false);
    await writeFile(pidFile, 'garbage');
    expect(await killStaleSidecar(pidFile, { run: async () => 'llama-server' })).toBe(false);
  });
});
