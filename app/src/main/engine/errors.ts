// Engine error type shared by every backend (no Electron imports, so it is usable from tests).

export type EngineErrorCode =
  | 'oom'
  | 'bad-file'
  | 'crashed'
  /** The OS refused to run the binary (Windows Smart App Control / AppLocker / antivirus). */
  | 'blocked'
  /** The llama-server sidecar binary is not installed in this build. */
  | 'unavailable'
  /** load()/start was superseded by unload()/shutdown()/another load(): not a failure. */
  | 'cancelled'
  | 'other';

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: EngineErrorCode = 'other'
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
