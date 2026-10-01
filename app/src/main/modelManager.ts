// Model manager: catalog + installed models on disk, downloads (resumable, multi-file, fallback URLs),
// import of local .gguf files, removal. No Electron imports: dialogs/paths are injected so this is testable.
//
// Layout:  <modelsDir>/<modelId>/manifest.json + the .gguf file(s)   (partials are "<file>.part")

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DownloadProgress, ModelEntry, Settings, UiLang } from '../shared/api';
import {
  type Catalog,
  type CatalogFile,
  type CatalogModel,
  isValidModelId,
  findSiblingMmproj,
  isMmprojName,
  localFileName,
  mmprojFileName,
  parseShardName,
  primaryModelFileName,
  sanitizeFileName,
  siblingShardNames
} from './catalog';
import {
  ChecksumError,
  classifyError,
  downloadFile,
  DownloadCancelledError,
  PART_SUFFIX,
  SizeMismatchError,
  type HttpOptions
} from './downloader';
import { msg, RicoError } from './messages';
import { atomicWriteJson, readJsonOr } from './storage';

const GiB = 1024 ** 3;
const MANIFEST = 'manifest.json';
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
const SPEED_WINDOW_MS = 4000;

export interface Manifest {
  id: string;
  source: 'catalog' | 'imported';
  files: { name: string; sizeBytes: number }[];
  primary: string;
  totalBytes: number;
  installedAt: number;
  name?: string;
  contextLength?: number;
  /** Multimodal projector file name (vision models). */
  mmproj?: string;
}

export interface LoadTarget {
  modelId: string;
  modelPath: string;
  sizeGB: number;
  requestedContext: number;
  chatTemplateHint?: string;
  /** Absolute path of the vision projector, when the model has one. */
  mmprojPath?: string;
}

export interface ModelManagerDeps {
  modelsDir: string;
  loadCatalog(): Promise<Catalog>;
  getSettings(): Promise<Settings>;
  emitProgress(p: DownloadProgress): void;
  /** Opens a native picker and returns the chosen .gguf path (or null if cancelled). */
  pickModelFile(): Promise<string | null>;
  lang(): UiLang;
  /** Test hooks. */
  http?: Pick<HttpOptions, 'allowInsecureLocalhost' | 'idleTimeoutMs'>;
  retryDelayMs?: (attempt: number) => number;
  now?: () => number;
  freeDiskBytes?: (dir: string) => Promise<number | undefined>;
}

// ---------------------------------------------------------------------------------------------------------
// Progress aggregation (pure, injectable clock)

export class ProgressTracker {
  private received: number[];
  private totals: (number | null)[];
  private samples: { t: number; bytes: number }[] = [];
  private lastEmit = -Infinity;

  constructor(
    fileCount: number,
    knownTotals: (number | undefined)[],
    private readonly estimatedTotalBytes: number,
    private readonly now: () => number = Date.now
  ) {
    this.received = new Array<number>(fileCount).fill(0);
    this.totals = knownTotals.map((t) => t ?? null);
  }

  update(index: number, received: number, total: number | null): void {
    this.received[index] = received;
    if (total !== null) this.totals[index] = total;
    const t = this.now();
    this.samples.push({ t, bytes: this.receivedBytes() });
    const cutoff = t - SPEED_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[0]!.t < cutoff) this.samples.shift();
  }

  receivedBytes(): number {
    return this.received.reduce((a, b) => a + b, 0);
  }

  totalBytes(): number {
    let known = 0;
    let unknownCount = 0;
    for (const t of this.totals) {
      if (t === null) unknownCount++;
      else known += t;
    }
    if (unknownCount === 0) return known;
    // Some files have not reported a size yet: fall back to the catalog's approximate size.
    return Math.max(known + unknownCount, this.estimatedTotalBytes, this.receivedBytes());
  }

  bytesPerSecond(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const dt = (last.t - first.t) / 1000;
    return dt > 0 ? Math.max(0, Math.round((last.bytes - first.bytes) / dt)) : 0;
  }

  /** True when a throttled progress event should be emitted now. */
  shouldEmit(force = false): boolean {
    const t = this.now();
    if (force || t - this.lastEmit >= PROGRESS_INTERVAL_MS) {
      this.lastEmit = t;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------

interface Job {
  controller: AbortController;
  tracker?: ProgressTracker;
}

export class ModelManager {
  private jobs = new Map<string, Job>();
  private errors = new Map<string, string>();

  constructor(private readonly deps: ModelManagerDeps) {}

  private get lang(): UiLang {
    return this.deps.lang();
  }

  private dirFor(id: string): string {
    return join(this.deps.modelsDir, id);
  }

  // -------------------------------------------------------------------------------------------------------
  // Reading state

  private async readManifest(id: string): Promise<Manifest | null> {
    if (!isValidModelId(id)) return null;
    const m = await readJsonOr<Manifest | null>(join(this.dirFor(id), MANIFEST), null);
    if (!m || m.id !== id || !Array.isArray(m.files) || m.files.length === 0 || typeof m.primary !== 'string') return null;
    for (const f of m.files) {
      try {
        const st = await fs.stat(join(this.dirFor(id), f.name));
        if (st.size !== f.sizeBytes) return null;
      } catch {
        return null;
      }
    }
    return m;
  }

  /** Names of the files a catalog entry installs (primary or fallback set, plus the projector). */
  private expectedNameSets(model: CatalogModel): string[][] {
    const sets: string[][] = [];
    for (const files of [model.files, ...(model.fallbackFiles?.length ? [model.fallbackFiles] : [])]) {
      const names = files.map((f, i) => localFileName(f, i));
      if (model.mmproj) names.push(mmprojFileName(model.mmproj, names));
      sets.push(names.sort());
    }
    return sets;
  }

  /**
   * A catalog model counts as installed only if what is on disk is what the CURRENT catalog describes
   * (an upgraded catalog entry, e.g. a text model replaced by a vision model, shows up as "not installed" again).
   */
  private async installedManifest(id: string, catalog?: Catalog): Promise<Manifest | null> {
    const manifest = await this.readManifest(id);
    if (!manifest) return null;
    const cat = catalog ?? (await this.deps.loadCatalog());
    const model = cat.models.find((m) => m.id === id);
    if (model && manifest.source === 'catalog') {
      const have = manifest.files.map((f) => f.name).sort().join('|');
      if (!this.expectedNameSets(model).some((n) => n.join('|') === have)) return null;
    }
    return manifest;
  }

  async list(): Promise<ModelEntry[]> {
    const [catalog, settings] = await Promise.all([this.deps.loadCatalog(), this.deps.getSettings()]);
    const activeId = settings.activeModelId;
    const entries: ModelEntry[] = [];
    const seen = new Set<string>();

    for (const m of catalog.models) {
      seen.add(m.id);
      const manifest = await this.installedManifest(m.id, catalog);
      const job = this.jobs.get(m.id);
      let status: ModelEntry['status'] = 'not-installed';
      let progress: number | undefined;
      let error: string | undefined;
      if (job) {
        status = 'downloading';
        const t = job.tracker;
        progress = t && t.totalBytes() > 0 ? Math.min(1, t.receivedBytes() / t.totalBytes()) : 0;
      } else if (manifest) {
        status = 'installed';
      } else if (this.errors.has(m.id)) {
        status = 'error';
        error = this.errors.get(m.id);
      }
      const entry: ModelEntry = {
        id: m.id,
        name: m.name,
        description: m.description,
        sizeGB: m.sizeGB,
        minRamGB: m.minRamGB,
        contextLength: m.contextLength,
        status,
        isActive: activeId === m.id && status === 'installed',
        source: 'catalog',
        supportsVision: !!m.mmproj
      };
      if (progress !== undefined) entry.progress = progress;
      if (error) entry.error = error;
      entries.push(entry);
    }

    // Imported models (and any installed model that is no longer in the catalog).
    let dirs: string[] = [];
    try {
      dirs = await fs.readdir(this.deps.modelsDir);
    } catch {
      /* none yet */
    }
    for (const id of dirs.sort()) {
      if (seen.has(id) || !isValidModelId(id)) continue;
      const manifest = await this.readManifest(id);
      const job = this.jobs.get(id);
      if (!manifest && !job) continue;
      const displayName = manifest?.name ?? id;
      const sizeGB = Math.round(((manifest?.totalBytes ?? 0) / GiB) * 10) / 10;
      const entry: ModelEntry = {
        id,
        name: { ar: displayName, en: displayName },
        description: {
          ar: manifest?.source === 'catalog' ? 'نموذج مثبّت' : 'نموذج مستورد من ملف',
          en: manifest?.source === 'catalog' ? 'Installed model' : 'Imported from a local file'
        },
        sizeGB,
        minRamGB: Math.ceil(sizeGB * 1.3 + 1),
        contextLength: manifest?.contextLength ?? 8192,
        status: job ? 'downloading' : 'installed',
        isActive: activeId === id,
        source: 'imported',
        supportsVision: !!manifest?.mmproj
      };
      if (job?.tracker) {
        entry.progress = job.tracker.totalBytes() > 0 ? Math.min(1, job.tracker.receivedBytes() / job.tracker.totalBytes()) : 0;
      }
      entries.push(entry);
    }
    return entries;
  }

  async isInstalled(id: string): Promise<boolean> {
    return (await this.installedManifest(id)) !== null;
  }

  async installedIds(): Promise<string[]> {
    return (await this.list()).filter((e) => e.status === 'installed').map((e) => e.id);
  }

  /** Everything the engine needs to load an installed model. */
  async resolveForLoad(id: string): Promise<LoadTarget | null> {
    const catalog = await this.deps.loadCatalog();
    const manifest = await this.installedManifest(id, catalog);
    if (!manifest) return null;
    const cm = catalog.models.find((m) => m.id === id);
    const modelBytes = manifest.files.filter((f) => f.name !== manifest.mmproj).reduce((n, f) => n + f.sizeBytes, 0);
    const sizeGB = modelBytes / GiB;
    return {
      modelId: id,
      modelPath: join(this.dirFor(id), manifest.primary),
      sizeGB,
      requestedContext: cm?.contextLength ?? manifest.contextLength ?? 8192,
      chatTemplateHint: cm?.chatTemplateHint,
      mmprojPath: manifest.mmproj ? join(this.dirFor(id), manifest.mmproj) : undefined
    };
  }

  // -------------------------------------------------------------------------------------------------------
  // Downloading

  isBusy(id: string): boolean {
    return this.jobs.has(id);
  }

  cancelDownload(id: string): void {
    this.jobs.get(id)?.controller.abort();
  }

  private async freeDisk(dir: string): Promise<number | undefined> {
    if (this.deps.freeDiskBytes) return this.deps.freeDiskBytes(dir);
    try {
      await fs.mkdir(dir, { recursive: true });
      const s = await fs.statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return undefined;
    }
  }

  private async assertDiskSpace(dir: string, neededBytes: number): Promise<void> {
    const free = await this.freeDisk(dir);
    if (free !== undefined && free < neededBytes + DISK_MARGIN_BYTES) {
      const needGB = Math.ceil(((neededBytes + DISK_MARGIN_BYTES) / GiB) * 10) / 10;
      throw new RicoError('notEnoughDisk', this.lang, String(needGB));
    }
  }

  /**
   * Downloads a catalog model. Resolves when the model is installed (or the download was cancelled);
   * rejects with a localised Error otherwise. Progress is pushed through deps.emitProgress.
   */
  async download(modelId: string): Promise<void> {
    if (!isValidModelId(modelId)) throw new RicoError('unknownModel', this.lang);
    // Claim the slot synchronously so two quick calls (double click) can never both start.
    if (this.jobs.has(modelId)) throw new RicoError('alreadyDownloading', this.lang);
    const controller = new AbortController();
    const job: Job = { controller };
    this.jobs.set(modelId, job);

    let model: CatalogModel | undefined;
    try {
      const catalog = await this.deps.loadCatalog();
      model = catalog.models.find((m) => m.id === modelId);
      if (!model || model.files.length === 0) throw new RicoError('unknownModel', this.lang);
      if (await this.installedManifest(modelId, catalog)) {
        this.jobs.delete(modelId);
        return;
      }
    } catch (err) {
      this.jobs.delete(modelId);
      throw err;
    }

    const dir = this.dirFor(modelId);
    this.errors.delete(modelId);

    const emit = (status: DownloadProgress['status'], error?: string, force = true): void => {
      const t = job.tracker;
      if (!force && t && !t.shouldEmit()) return;
      const p: DownloadProgress = {
        modelId,
        receivedBytes: t?.receivedBytes() ?? 0,
        totalBytes: t?.totalBytes() ?? Math.round(model!.sizeGB * GiB),
        bytesPerSecond: status === 'downloading' ? (t?.bytesPerSecond() ?? 0) : 0,
        status
      };
      if (error) p.error = error;
      this.deps.emitProgress(p);
    };

    try {
      await fs.mkdir(dir, { recursive: true });
      const sets: CatalogFile[][] = [model.files];
      if (model.fallbackFiles && model.fallbackFiles.length > 0) sets.push(model.fallbackFiles);

      let lastErr: unknown;
      let installed: Manifest | undefined;
      for (let s = 0; s < sets.length; s++) {
        const files = sets[s]!;
        try {
          installed = await this.runFileSet(model, files, dir, job, controller.signal, emit);
          break;
        } catch (err) {
          lastErr = err;
          if (controller.signal.aborted || classifyError(err) === 'cancelled') throw err;
          // Discard partial data of the failed set before trying the complete alternative set.
          if (s < sets.length - 1) await this.cleanPartials(dir, files);
        }
      }
      if (!installed) throw lastErr ?? new Error('Download failed');

      await atomicWriteJson(join(dir, MANIFEST), installed);
      await this.pruneStray(dir, installed);
      emit('done');
    } catch (err) {
      if (controller.signal.aborted || err instanceof DownloadCancelledError) {
        emit('cancelled');
        return;
      }
      const message = this.describeDownloadError(err);
      this.errors.set(modelId, message);
      emit('error', message);
      throw new Error(message);
    } finally {
      this.jobs.delete(modelId);
    }
  }

  /** Removes files of a previous catalog version (and leftover partials) once the new set is installed. */
  private async pruneStray(dir: string, manifest: Manifest): Promise<void> {
    const keep = new Set([MANIFEST, ...manifest.files.map((f) => f.name)]);
    try {
      for (const name of await fs.readdir(dir)) {
        if (!keep.has(name)) await fs.rm(join(dir, name), { force: true, recursive: true }).catch(() => undefined);
      }
    } catch {
      /* best effort */
    }
  }

  private describeDownloadError(err: unknown): string {
    if (err instanceof RicoError) return err.message;
    if (err instanceof ChecksumError) return msg('checksumFailed', this.lang);
    if (err instanceof SizeMismatchError) return msg('downloadFailed', this.lang, err.message);
    const kind = classifyError(err);
    if (kind === 'offline') return msg('downloadOffline', this.lang);
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOSPC') return msg('notEnoughDisk', this.lang, '?');
    return msg('downloadFailed', this.lang, err instanceof Error ? err.message : String(err));
  }

  private async cleanPartials(dir: string, files: CatalogFile[]): Promise<void> {
    await Promise.all(
      files.map((f, i) => fs.rm(join(dir, localFileName(f, i) + PART_SUFFIX), { force: true }).catch(() => undefined))
    );
  }

  private async runFileSet(
    model: CatalogModel,
    files: CatalogFile[],
    dir: string,
    job: Job,
    signal: AbortSignal,
    emit: (status: DownloadProgress['status'], error?: string, force?: boolean) => void
  ): Promise<Manifest> {
    const modelNames = files.map((f, i) => localFileName(f, i));
    const mmprojName = model.mmproj ? mmprojFileName(model.mmproj, modelNames) : undefined;
    if (model.mmproj && mmprojName) files = [...files, model.mmproj];
    const names = mmprojName ? [...modelNames, mmprojName] : modelNames;
    if (new Set(names).size !== names.length) throw new Error('Catalog lists duplicate file names');

    const tracker = new ProgressTracker(
      files.length,
      files.map((f) => f.sizeBytes),
      Math.round(model.sizeGB * GiB),
      this.deps.now
    );
    job.tracker = tracker;

    // Disk space: everything not yet on disk.
    let alreadyOnDisk = 0;
    for (const n of names) {
      for (const suffix of ['', PART_SUFFIX]) {
        try {
          alreadyOnDisk += (await fs.stat(join(dir, n + suffix))).size;
        } catch {
          /* missing */
        }
      }
    }
    await this.assertDiskSpace(dir, Math.max(0, tracker.totalBytes() - alreadyOnDisk));

    emit('downloading', undefined, true);

    const sizes: number[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const dest = join(dir, names[i]!);
      const urls = [file.url, ...(file.fallbackUrl ? [file.fallbackUrl] : [])];
      let lastErr: unknown;
      let ok = false;
      for (let u = 0; u < urls.length && !ok; u++) {
        try {
          await downloadFile({
            url: urls[u]!,
            destPath: dest,
            expectedSize: file.sizeBytes,
            sha256: file.sha256,
            signal,
            http: this.deps.http,
            retryDelayMs: this.deps.retryDelayMs,
            onBytes: (received, total) => {
              tracker.update(i, received, total);
              emit('downloading', undefined, false);
            },
            onVerifying: () => emit('verifying')
          });
          ok = true;
        } catch (err) {
          lastErr = err;
          if (signal.aborted || classifyError(err) === 'cancelled') throw err;
          // A different source may serve different bytes: never resume its partial data from another URL.
          await fs.rm(dest + PART_SUFFIX, { force: true }).catch(() => undefined);
          tracker.update(i, 0, file.sizeBytes ?? null);
        }
      }
      if (!ok) throw lastErr ?? new Error('Download failed');
      sizes.push((await fs.stat(dest)).size);
    }

    const primary = primaryModelFileName(modelNames);
    if (!primary) throw new Error('The catalog entry has no .gguf file');
    return {
      id: model.id,
      source: 'catalog',
      files: names.map((name, i) => ({ name, sizeBytes: sizes[i]! })),
      primary,
      totalBytes: sizes.reduce((a, b) => a + b, 0),
      installedAt: Date.now(),
      contextLength: model.contextLength,
      ...(mmprojName ? { mmproj: mmprojName } : {})
    };
  }

  // -------------------------------------------------------------------------------------------------------
  // Import

  private async uniqueImportedId(base: string): Promise<string> {
    const slug =
      base
        .toLowerCase()
        .replace(/\.gguf$/i, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'model';
    let id = `imported-${slug}`;
    for (let n = 2; ; n++) {
      try {
        await fs.access(this.dirFor(id));
        id = `imported-${slug}-${n}`;
      } catch {
        return id;
      }
    }
  }

  /** Copies a local .gguf (and sibling shards) into the models folder. Returns null if the user cancelled. */
  async importFile(): Promise<ModelEntry | null> {
    const picked = await this.deps.pickModelFile();
    if (!picked) return null;
    if (!picked.toLowerCase().endsWith('.gguf')) throw new RicoError('badModelFile', this.lang);
    if (!(await looksLikeGguf(picked))) throw new RicoError('badModelFile', this.lang);

    const srcDir = dirname(picked);
    const pickedName = basename(picked);
    if (isMmprojName(pickedName)) throw new RicoError('pickedMmproj', this.lang);
    const shardNames = siblingShardNames(pickedName);
    if (shardNames.length > 1) {
      const missing: string[] = [];
      for (const n of shardNames) {
        try {
          await fs.access(join(srcDir, n));
        } catch {
          missing.push(n);
        }
      }
      if (missing.length > 0) throw new RicoError('missingShards', this.lang, missing.slice(0, 3).join(', '));
    }
    // Optional: a projector sitting next to the model (same base name) makes the imported model vision-capable.
    let mmproj: string | undefined;
    try {
      const sibling = findSiblingMmproj(pickedName, await fs.readdir(srcDir));
      if (sibling && (await looksLikeGguf(join(srcDir, sibling)))) mmproj = sibling;
    } catch {
      /* no siblings readable: text-only import */
    }
    // Always load from the first shard.
    const names = mmproj ? [...shardNames, mmproj] : shardNames;
    const sizes: number[] = [];
    for (const n of names) sizes.push((await fs.stat(join(srcDir, n))).size);
    const total = sizes.reduce((a, b) => a + b, 0);

    const shardInfo = parseShardName(pickedName);
    const baseName = shardInfo ? shardInfo.prefix : pickedName.replace(/\.gguf$/i, '');
    const id = await this.uniqueImportedId(baseName);
    const dir = this.dirFor(id);
    await this.assertDiskSpace(this.deps.modelsDir, total);

    const controller = new AbortController();
    const job: Job = { controller };
    const tracker = new ProgressTracker(names.length, sizes, total, this.deps.now);
    job.tracker = tracker;
    this.jobs.set(id, job);

    const emit = (status: DownloadProgress['status'], error?: string, force = true): void => {
      if (!force && !tracker.shouldEmit()) return;
      const p: DownloadProgress = {
        modelId: id,
        receivedBytes: tracker.receivedBytes(),
        totalBytes: total,
        bytesPerSecond: status === 'downloading' ? tracker.bytesPerSecond() : 0,
        status
      };
      if (error) p.error = error;
      this.deps.emitProgress(p);
    };

    try {
      await fs.mkdir(dir, { recursive: true });
      emit('downloading');
      for (let i = 0; i < names.length; i++) {
        const dest = join(dir, sanitizeFileName(names[i]!));
        let copied = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            copied += chunk.length;
            tracker.update(i, copied, sizes[i]!);
            emit('downloading', undefined, false);
            cb(null, chunk);
          }
        });
        await pipeline(createReadStream(join(srcDir, names[i]!)), counter, createWriteStream(dest + PART_SUFFIX), {
          signal: controller.signal
        });
        await fs.rename(dest + PART_SUFFIX, dest);
      }
      const manifest: Manifest = {
        id,
        source: 'imported',
        files: names.map((n, i) => ({ name: sanitizeFileName(n), sizeBytes: sizes[i]! })),
        primary: sanitizeFileName(primaryModelFileName(shardNames) ?? shardNames[0]!),
        ...(mmproj ? { mmproj: sanitizeFileName(mmproj) } : {}),
        totalBytes: total,
        installedAt: Date.now(),
        name: baseName.slice(0, 80)
      };
      await atomicWriteJson(join(dir, MANIFEST), manifest);
      emit('done');
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (controller.signal.aborted || err instanceof DownloadCancelledError || (err as Error).name === 'AbortError') {
        emit('cancelled');
        return null;
      }
      const message = msg('downloadFailed', this.lang, err instanceof Error ? err.message : String(err));
      emit('error', message);
      throw new Error(message);
    } finally {
      this.jobs.delete(id);
    }

    const entry = (await this.list()).find((e) => e.id === id);
    return entry ?? null;
  }

  // -------------------------------------------------------------------------------------------------------

  async remove(id: string): Promise<void> {
    if (!isValidModelId(id)) throw new RicoError('unknownModel', this.lang);
    const job = this.jobs.get(id);
    if (job) {
      job.controller.abort();
      // give the download loop a moment to release its file handles
      for (let i = 0; i < 20 && this.jobs.has(id); i++) await new Promise((r) => setTimeout(r, 50));
    }
    this.errors.delete(id);
    await fs.rm(this.dirFor(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Checks the 4-byte GGUF magic. */
export async function looksLikeGguf(path: string): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, 'r');
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf.toString('latin1') === 'GGUF';
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
