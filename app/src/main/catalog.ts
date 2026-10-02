// Model catalog (models/catalog.json, owned by Agent D) parsing + file-name helpers. Pure functions.

export interface CatalogFile {
  url: string;
  fallbackUrl?: string;
  sha256?: string;
  sizeBytes?: number;
  /** sha256 / size of the bytes behind `fallbackUrl` when they differ from the primary file (e.g. a single HF GGUF vs. GitHub shards). */
  fallbackSha256?: string;
  fallbackSizeBytes?: number;
  /** Local file name. Defaults to the last path segment of `url` (important for split shards). */
  name?: string;
}

export interface CatalogModel {
  id: string;
  name: { ar: string; en: string };
  description: { ar: string; en: string };
  sizeGB: number;
  minRamGB: number;
  contextLength: number;
  files: CatalogFile[];
  /**
   * Optional complete alternative file set (e.g. the original single-file Hugging Face GGUF when the primary
   * files are GitHub-hosted shards). Tried only after every primary file/fallbackUrl failed.
   */
  fallbackFiles?: CatalogFile[];
  /** Multimodal projector GGUF: present => the model can see images (downloaded alongside the model). */
  mmproj?: CatalogFile;
  chatTemplateHint?: string;
}

export interface Catalog {
  version: number | string;
  models: CatalogModel[];
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidModelId(id: unknown): id is string {
  return typeof id === 'string' && MODEL_ID_RE.test(id);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function parseBilingual(v: unknown, fallback: string): { ar: string; en: string } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const ar = str(o.ar);
  const en = str(o.en);
  return { ar: ar ?? en ?? fallback, en: en ?? ar ?? fallback };
}

function parseFiles(raw: unknown): CatalogFile[] {
  if (!Array.isArray(raw)) return [];
  const out: CatalogFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    const url = str(r.url);
    if (!url) continue;
    const file: CatalogFile = { url };
    const fb = str(r.fallbackUrl);
    if (fb) file.fallbackUrl = fb;
    const sha = str(r.sha256);
    if (sha) file.sha256 = sha;
    const size = num(r.sizeBytes);
    if (size !== undefined && size > 0) file.sizeBytes = Math.round(size);
    const fbSha = str(r.fallbackSha256);
    if (fbSha) file.fallbackSha256 = fbSha;
    const fbSize = num(r.fallbackSizeBytes);
    if (fbSize !== undefined && fbSize > 0) file.fallbackSizeBytes = Math.round(fbSize);
    const name = str(r.name);
    if (name) file.name = name;
    out.push(file);
  }
  return out;
}

/**
 * Catalog convention for GitHub-packaged models ("packaged": shards on GitHub, original single GGUF on Hugging Face):
 * files[0].fallbackUrl (+ fallbackSha256 / fallbackSizeBytes) describes ONE replacement file for the WHOLE shard set.
 * Per-file fallbackUrl is therefore turned into a complete `fallbackFiles` set (the single HF file is never compared
 * with shard 1's size/sha) and removed from the shards. Single-file entries without a fallback checksum keep the
 * simple per-file fallbackUrl behaviour. (mmproj keeps its own per-file fallbackUrl.)
 */
function derivePackagedFallback(model: CatalogModel): void {
  const f0 = model.files[0];
  if (!f0 || !f0.fallbackUrl || model.fallbackFiles) return;
  if (!(f0.fallbackSha256 || model.files.length > 1)) return;
  const alt: CatalogFile = { url: f0.fallbackUrl };
  if (f0.fallbackSha256) alt.sha256 = f0.fallbackSha256;
  if (f0.fallbackSizeBytes) alt.sizeBytes = f0.fallbackSizeBytes;
  model.fallbackFiles = [alt];
  for (const f of model.files) {
    delete f.fallbackUrl;
    delete f.fallbackSha256;
    delete f.fallbackSizeBytes;
  }
}

/** Tolerant parser: invalid models are skipped, missing optional fields get sensible defaults. */
export function parseCatalog(raw: unknown): Catalog {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.models)) {
    for (const m of r.models) {
      if (!m || typeof m !== 'object') continue;
      const o = m as Record<string, unknown>;
      if (!isValidModelId(o.id) || seen.has(o.id)) continue;
      const files = parseFiles(o.files);
      const model: CatalogModel = {
        id: o.id,
        name: parseBilingual(o.name, o.id),
        description: parseBilingual(o.description, ''),
        sizeGB: num(o.sizeGB) ?? 0,
        minRamGB: num(o.minRamGB) ?? 0,
        contextLength: Math.round(num(o.contextLength) ?? 8192),
        files
      };
      const fallbackFiles = parseFiles(o.fallbackFiles);
      if (fallbackFiles.length > 0) model.fallbackFiles = fallbackFiles;
      derivePackagedFallback(model);
      const mmproj = parseFiles(o.mmproj ? [o.mmproj] : [])[0];
      if (mmproj) model.mmproj = mmproj;
      const hint = str(o.chatTemplateHint);
      if (hint) model.chatTemplateHint = hint;
      models.push(model);
      seen.add(model.id);
    }
  }
  const version = typeof r.version === 'number' || typeof r.version === 'string' ? r.version : 0;
  return { version, models };
}

/** Local file name for a catalog file: explicit `name`, else the URL's last path segment, else `part-N.gguf`. */
export function localFileName(file: CatalogFile, index: number): string {
  const explicit = file.name ? sanitizeFileName(file.name) : '';
  if (explicit) return explicit;
  try {
    const last = decodeURIComponent(new URL(file.url).pathname.split('/').filter(Boolean).pop() ?? '');
    const clean = sanitizeFileName(last);
    if (clean) return clean;
  } catch {
    /* fall through */
  }
  return `part-${String(index + 1).padStart(5, '0')}.gguf`;
}

export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return base.slice(0, 200);
}

const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

export interface ShardInfo {
  prefix: string;
  index: number;
  count: number;
}

export function parseShardName(fileName: string): ShardInfo | null {
  const m = SHARD_RE.exec(fileName);
  if (!m) return null;
  return { prefix: m[1]!, index: Number(m[2]), count: Number(m[3]) };
}

/** All shard file names belonging to the same split model as `fileName` (just `[fileName]` if not a shard). */
export function siblingShardNames(fileName: string): string[] {
  const s = parseShardName(fileName);
  if (!s || s.count < 1 || s.count > 999) return [fileName];
  const width = 5;
  const out: string[] = [];
  for (let i = 1; i <= s.count; i++) {
    out.push(`${s.prefix}-${String(i).padStart(width, '0')}-of-${String(s.count).padStart(width, '0')}.gguf`);
  }
  return out;
}

/** The file node-llama-cpp must be pointed at: the first shard of a split model, else the first .gguf. */
export function primaryModelFileName(fileNames: readonly string[]): string | undefined {
  const ggufs = fileNames.filter((n) => n.toLowerCase().endsWith('.gguf'));
  const first = ggufs.find((n) => parseShardName(n)?.index === 1);
  return first ?? ggufs[0];
}

/** Local file name of the projector (never collides with model files: it is prefixed when it would). */
export function mmprojFileName(file: CatalogFile, modelFileNames: readonly string[]): string {
  let name = localFileName(file, 0);
  if (modelFileNames.includes(name)) name = `mmproj-${name}`;
  return name;
}

// Quantisation / precision tokens that differ between a model file and its projector (Q4_K_M, IQ3_XS, F16, BF16...).
const QUANT_RE = /(?:^|[-_.])(?:i?q\d(?:_[a-z0-9]+)*|b?f(?:16|32))(?=$|[-_.])/gi;

function baseKey(fileName: string): string {
  return fileName
    .toLowerCase()
    .replace(/\.gguf$/, '')
    .replace(/mmproj/g, '')
    .replace(QUANT_RE, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Finds the projector that belongs to `modelName` among sibling .gguf files (same base name, any quantisation). */
export function findSiblingMmproj(modelName: string, siblings: readonly string[]): string | undefined {
  const key = baseKey(parseShardName(modelName)?.prefix ?? modelName);
  if (!key) return undefined;
  const matches = siblings.filter((n) => /mmproj/i.test(n) && /\.gguf$/i.test(n) && baseKey(n) === key);
  return matches.length === 1 ? matches[0] : undefined;
}

export function isMmprojName(fileName: string): boolean {
  return /mmproj/i.test(fileName);
}
