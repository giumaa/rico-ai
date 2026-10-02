// Downloads the official llama.cpp release binaries (llama-server) that Rico runs as its inference sidecar,
// and unpacks them into app/resources/bin/<os>-<arch>/<variant>/  (os = win | mac | linux, as electron-builder's ${os}).
//
//   node scripts/fetch-llama-server.mjs                       # current platform, all variants
//   node scripts/fetch-llama-server.mjs --platform win-x64    # one platform
//   node scripts/fetch-llama-server.mjs --platform all        # CI: everything (win-x64 mac-arm64 mac-x64 linux-x64)
//   node scripts/fetch-llama-server.mjs --variant vulkan      # only one variant (vulkan | cpu | metal | default)
//   node scripts/fetch-llama-server.mjs --tag b11321 --force
//   node scripts/fetch-llama-server.mjs --verify              # after fetching, run `llama-server --version` (native platform only)
//
// The pinned tag lives in the repo-root file LLAMA_CPP_TAG (single source of truth for CI and local builds);
// precedence: --tag > $LLAMA_CPP_TAG > that file > the built-in default below.
//
// Source: https://github.com/ggml-org/llama.cpp/releases (official builds). Each archive is verified against
// the sha256 digest GitHub publishes for the release asset. This is a build-time tool: the app itself never
// downloads binaries. Uses only Node built-ins plus the system `tar` / `unzip` / PowerShell for extraction.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

/** Fallback pin when LLAMA_CPP_TAG (repo root) is missing. Bump deliberately: llama-server flags change between builds (see src/main/engine/serverCore.ts). */
const BUILTIN_TAG = 'b11321';
const REPO = 'ggml-org/llama.cpp';

/** platform -> variants -> asset name builder */
const PLATFORMS = {
  'win-x64': [
    { variant: 'vulkan', asset: (t) => `llama-${t}-bin-win-vulkan-x64.zip` },
    { variant: 'cpu', asset: (t) => `llama-${t}-bin-win-cpu-x64.zip` }
  ],
  'mac-arm64': [{ variant: 'metal', asset: (t) => `llama-${t}-bin-macos-arm64.tar.gz` }],
  'mac-x64': [{ variant: 'default', asset: (t) => `llama-${t}-bin-macos-x64.tar.gz` }],
  'linux-x64': [
    { variant: 'vulkan', asset: (t) => `llama-${t}-bin-ubuntu-vulkan-x64.tar.gz` },
    { variant: 'cpu', asset: (t) => `llama-${t}-bin-ubuntu-x64.tar.gz` }
  ]
};

const here = dirname(fileURLToPath(import.meta.url));
const binRoot = resolve(here, '..', 'resources', 'bin');

function readPinnedTag() {
  try {
    const raw = readFileSync(resolve(here, '..', '..', 'LLAMA_CPP_TAG'), 'utf8');
    const t = raw.split(/[\r\n]+/).filter((l) => !l.trim().startsWith('#')).join('').trim(); // '#' comment lines allowed
    if (/^b\d+$/.test(t)) return t;
  } catch {
    /* no file: use the built-in pin */
  }
  return BUILTIN_TAG;
}
const DEFAULT_TAG = readPinnedTag();

function parseArgs(argv) {
  const out = { platform: 'current', variant: 'all', tag: process.env.LLAMA_CPP_TAG || DEFAULT_TAG, force: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--verify') out.verify = true;
    else if (a === '--platform') out.platform = argv[++i];
    else if (a === '--variant') out.variant = argv[++i];
    else if (a === '--tag') out.tag = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function currentPlatform() {
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  return `${os}-${process.arch}`;
}

async function sha256File(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

async function githubJson(url) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'rico-fetch-llama-server' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'rico-fetch-llama-server' } });
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
  return r.status === 0 && !r.error;
}

/** Extracts .zip / .tar.gz with whatever the machine has (bsdtar on Windows 10+/macOS, unzip, PowerShell). */
function extract(archive, destDir) {
  if (archive.endsWith('.tar.gz')) {
    if (run('tar', ['-xzf', archive, '-C', destDir])) return;
    throw new Error('Could not extract tar.gz (is `tar` installed?)');
  }
  if (run('tar', ['-xf', archive, '-C', destDir])) return; // bsdtar reads zip
  if (run('unzip', ['-o', '-q', archive, '-d', destDir])) return;
  if (process.platform === 'win32') {
    const ps = `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`;
    if (run('powershell', ['-NoProfile', '-Command', ps])) return;
  }
  throw new Error('Could not extract the zip archive (need bsdtar, unzip or PowerShell)');
}

async function findFile(dir, predicate) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(p, predicate);
      if (found) return found;
    } else if (predicate(entry.name)) return p;
  }
  return null;
}

const TOOL_WORDS =
  /(^|[-_.])(cli|bench|batched-bench|completion|fit-params|perplexity|quantize|imatrix|gguf-split|export-lora|tokenize|parallel|embedding|eval-callback|retrieval|lookup|speculative|infill|tts)([-_.]|$)/;

/** What stays in the shipped folder: llama-server + the libraries it loads. */
export function shouldKeep(name, serverExe) {
  const n = name.toLowerCase();
  if (n === serverExe) return true;
  if (/^license|\.txt$|\.md$|^\.rico-/.test(n)) return true;
  if (/^(llama|rpc-server|ggml-rpc-server)(\.exe)?$/.test(n)) return false; // unified CLI / RPC server executables
  // macOS/Linux: llama-server is LINKED against its shared libraries (incl. libggml-rpc: dyld looks for
  // @rpath/libggml-rpc.0.dylib), so every lib*.dylib / lib*.so* (and the versioned symlinks) must stay.
  if (/[.](dylib|so)([.][0-9.]+)?$/.test(n)) return true;
  // Windows: the RPC backend is a dlopen'ed plugin (ggml-rpc.dll) with network code: not shipped.
  if (n.includes('ggml-rpc')) return false;
  if (n.endsWith('.exe') || n.startsWith('test-')) return false;
  if (TOOL_WORDS.test(n) && !n.includes('server')) return false; // llama-cli / bench / quantize ... and their *-impl libraries
  return true;
}

async function prune(dir, serverExe) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!shouldKeep(entry.name, serverExe)) await rm(join(dir, entry.name), { force: true });
  }
}

/** Runs `llama-server --version` from the installed folder. Only meaningful (and only attempted) on the native platform. */
function verifyOne(platform, entry) {
  if (platform !== currentPlatform()) {
    console.log(`[fetch-llama-server] --verify: skipping ${platform}/${entry.variant} (cannot run a ${platform} binary on ${currentPlatform()})`);
    return;
  }
  const dest = join(binRoot, platform, entry.variant);
  const exe = join(dest, platform.startsWith('win') ? 'llama-server.exe' : 'llama-server');
  const r = spawnSync(exe, ['--version'], { cwd: dest, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/)[0] ?? '';
  if (r.status !== 0 || r.error) throw new Error(`--verify failed for ${platform}/${entry.variant}: ${r.error?.message ?? `exit ${r.status}`} ${out}`);
  console.log(`[fetch-llama-server] --verify ok: ${platform}/${entry.variant}: ${out}`);
}

async function installOne(platform, entry, tag, force) {
  const dest = join(binRoot, platform, entry.variant);
  const exe = platform.startsWith('win') ? 'llama-server.exe' : 'llama-server';
  const marker = join(dest, '.rico-llama-tag');
  if (!force && existsSync(join(dest, exe)) && existsSync(marker) && (await readFile(marker, 'utf8')).trim() === tag) {
    console.log(`[fetch-llama-server] ${platform}/${entry.variant} already at ${tag} (use --force to refetch)`);
    return;
  }

  const assetName = entry.asset(tag);
  const release = await githubJson(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`);
  const asset = (release.assets ?? []).find((a) => a.name === assetName);
  if (!asset) throw new Error(`Release ${tag} has no asset ${assetName}`);

  const work = await mkdtemp(join(tmpdir(), 'rico-llama-'));
  try {
    const archive = join(work, assetName);
    console.log(`[fetch-llama-server] downloading ${assetName} (${(asset.size / 1e6).toFixed(1)} MB)`);
    await download(asset.browser_download_url, archive);
    const expected = typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/, '') : undefined;
    if (expected) {
      const actual = await sha256File(archive);
      if (actual !== expected) throw new Error(`sha256 mismatch for ${assetName}: expected ${expected}, got ${actual}`);
      console.log('[fetch-llama-server] sha256 verified');
    } else {
      console.warn('[fetch-llama-server] WARNING: GitHub published no digest for this asset; skipping verification');
    }

    const unpacked = join(work, 'unpacked');
    await mkdir(unpacked, { recursive: true });
    extract(archive, unpacked);
    const serverPath = await findFile(unpacked, (n) => n === exe);
    if (!serverPath) throw new Error(`${exe} not found inside ${assetName}`);

    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await cp(dirname(serverPath), dest, { recursive: true, verbatimSymlinks: true });
    await prune(dest, exe);
    await writeFile(marker, `${tag}\n`);
    console.log(`[fetch-llama-server] installed ${platform}/${entry.variant} -> ${dest}`);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node scripts/fetch-llama-server.mjs [--platform ${Object.keys(PLATFORMS).join('|')}|all|current] [--variant vulkan|cpu|metal|default|all] [--tag ${DEFAULT_TAG}] [--force] [--verify]`);
    return;
  }
  const platforms = args.platform === 'all' ? Object.keys(PLATFORMS) : [args.platform === 'current' ? currentPlatform() : args.platform];
  for (const platform of platforms) {
    const entries = PLATFORMS[platform];
    if (!entries) throw new Error(`Unsupported platform "${platform}". Supported: ${Object.keys(PLATFORMS).join(', ')}`);
    const wanted = entries.filter((e) => args.variant === 'all' || e.variant === args.variant);
    if (wanted.length === 0) throw new Error(`No variant "${args.variant}" for ${platform}`);
    for (const entry of wanted) {
      await installOne(platform, entry, args.tag, args.force);
      if (args.verify) verifyOne(platform, entry);
    }
  }
}

// Only run when executed directly (the helpers above are imported by the unit tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[fetch-llama-server] FAILED:', err.message ?? err);
    process.exit(1);
  });
}
