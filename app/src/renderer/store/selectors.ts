import type { ModelEntry } from '@shared/api';
import { MAX_EDGE_DEFAULT, MAX_IMAGES } from '../lib/image';
import type { AppState } from './types';

/** True when the active model is known NOT to understand images (supportsVision === false). */
export function visionBlocked(state: Pick<AppState, 'models'>): boolean {
  return state.models.find((m) => m.isActive)?.supportsVision === false;
}

export interface ImageLimits {
  maxImages: number;
  /** long-edge size images are downscaled to before sending */
  maxEdge: number;
}

/**
 * Small-context models (<= 4096 tokens, typically 8 GB machines) cannot afford 4 images of ~1200 tokens:
 * allow 2 and downscale to 896px. An explicit `maxImages` on the model entry (set by main) wins.
 */
export function imageLimits(state: Pick<AppState, 'models'>): ImageLimits {
  const m = state.models.find((x) => x.isActive) as (ModelEntry & { maxImages?: number }) | undefined;
  const small = !!m && m.contextLength > 0 && m.contextLength <= 4096;
  const explicit = typeof m?.maxImages === 'number' && m.maxImages > 0 ? m.maxImages : undefined;
  return {
    maxImages: Math.min(MAX_IMAGES, explicit ?? (small ? 2 : MAX_IMAGES)),
    maxEdge: small ? 896 : MAX_EDGE_DEFAULT,
  };
}
