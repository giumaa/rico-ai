import type { ModelEntry } from '@shared/api';
import { MAX_EDGE_DEFAULT, MAX_IMAGES } from '../lib/image';
import type { AppState } from './types';

/**
 * True when the loaded ENGINE reports that it cannot read images right now (e.g. the image engine was blocked by Windows),
 * even though the model itself supports vision (ModelEntry.supportsVision).
 */
export function engineVisionOff(state: Pick<AppState, 'models' | 'loadState'>): boolean {
  const active = state.models.find((m) => m.isActive);
  const ls = state.loadState;
  return !!active && ls.state === 'ready' && ls.vision === false && (!ls.modelId || ls.modelId === active.id);
}

/** True when images cannot be used: the active model is text-only, or its engine has vision switched off. */
export function visionBlocked(state: Pick<AppState, 'models' | 'loadState'>): boolean {
  const active = state.models.find((m) => m.isActive);
  return active?.supportsVision === false || (active?.supportsVision === true && engineVisionOff(state));
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
