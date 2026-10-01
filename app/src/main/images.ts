// Validation helpers for image attachments (user messages). Pure functions.

import type { ImageAttachment } from '../shared/api';

export const MAX_IMAGES_PER_MESSAGE = 6;
/** ~10 MB of image data once decoded. The renderer downsizes to <= 1280 px, so real images are far smaller. */
export const MAX_IMAGE_BASE64_CHARS = 14_000_000;
/** Only the most recent images stay in the prompt (each one costs hundreds of tokens of context). */
export const MAX_IMAGES_IN_CONTEXT = 4;

const MIMES = new Set<ImageAttachment['mime']>(['image/png', 'image/jpeg', 'image/webp']);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Returns only well-formed attachments (bad ones are dropped, never repaired). */
export function sanitizeImages(raw: unknown): ImageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: ImageAttachment[] = [];
  for (const item of raw) {
    if (out.length >= MAX_IMAGES_PER_MESSAGE) break;
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (!MIMES.has(r.mime as ImageAttachment['mime'])) continue;
    if (typeof r.dataBase64 !== 'string') continue;
    const data = r.dataBase64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (data.length < 8 || data.length > MAX_IMAGE_BASE64_CHARS || !BASE64_RE.test(data)) continue;
    const img: ImageAttachment = {
      id: typeof r.id === 'string' && r.id ? r.id.slice(0, 100) : `img-${out.length}-${data.length}`,
      mime: r.mime as ImageAttachment['mime'],
      dataBase64: data
    };
    if (typeof r.name === 'string') img.name = r.name.slice(0, 200);
    if (typeof r.width === 'number' && Number.isFinite(r.width)) img.width = Math.round(r.width);
    if (typeof r.height === 'number' && Number.isFinite(r.height)) img.height = Math.round(r.height);
    out.push(img);
  }
  return out;
}

export function dataUri(img: Pick<ImageAttachment, 'mime' | 'dataBase64'>): string {
  return `data:${img.mime};base64,${img.dataBase64}`;
}
