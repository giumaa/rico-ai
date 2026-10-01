// Cleans up a llama-server sidecar left behind by a crashed/killed app (it would keep gigabytes of RAM busy).
// The PID is only killed after verifying the process really is llama-server (PIDs get reused by the OS).

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';

export type RunCommand = (cmd: string, args: string[]) => Promise<string>;

const defaultRun: RunCommand = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (_err, stdout) => resolve(String(stdout ?? '')));
  });

export function parsePid(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n > 1 ? n : null;
}

export async function killStaleSidecar(
  pidFile: string,
  opts: { platform?: NodeJS.Platform; run?: RunCommand; kill?: (pid: number) => void } = {}
): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  const kill = opts.kill ?? ((pid: number) => process.kill(pid));
  let pid: number | null;
  try {
    pid = parsePid(await fs.readFile(pidFile, 'utf8'));
  } catch {
    return false;
  }
  await fs.rm(pidFile, { force: true }).catch(() => undefined);
  if (pid === null) return false;

  const out =
    platform === 'win32'
      ? await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      : await run('ps', ['-p', String(pid), '-o', 'comm=']);
  if (!/llama-server/i.test(out)) return false;
  try {
    kill(pid);
    return true;
  } catch {
    return false;
  }
}
