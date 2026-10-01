import type { AppState } from './types';

/** True when the active model is known NOT to understand images (supportsVision === false). */
export function visionBlocked(state: Pick<AppState, 'models'>): boolean {
  return state.models.find((m) => m.isActive)?.supportsVision === false;
}
