import type { ImageAttachment } from '@shared/api';
import { uid } from './text';

export const MAX_IMAGES = 4;
export const MAX_EDGE_DEFAULT = 1280;
const JPEG_QUALITY = 0.85;

/** SVG is excluded on purpose (scriptable); everything else the browser can decode is accepted. */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') && file.type !== 'image/svg+xml';
}

export const imageSrc = (img: Pick<ImageAttachment, 'mime' | 'dataBase64'>): string =>
  `data:${img.mime};base64,${img.dataBase64}`;

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file); // applies EXIF orientation
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
    } catch {
      /* fall back to <img> below */
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1)); // strip the "data:…;base64," prefix
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Downscale to ≤1280px (≤896px for small-context models) on the long edge and re-encode as JPEG (q 0.85) so every attachment is
 * small and in a format any vision backend can read. Transparent areas are flattened onto white.
 */
export async function fileToAttachment(file: File, maxEdge = MAX_EDGE_DEFAULT): Promise<ImageAttachment> {
  const { source, width, height, release } = await decode(file);
  try {
    if (!width || !height) throw new Error('empty image');
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new Error('encode failed');
    return {
      id: uid(),
      mime: 'image/jpeg',
      dataBase64: await blobToBase64(blob),
      name: file.name || undefined,
      width: w,
      height: h,
    };
  } finally {
    release();
  }
}
