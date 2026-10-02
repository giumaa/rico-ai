// Chat generation controller: persona assembly, streaming events to the renderer, stop / pre-emption.

import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type { DoneEvent, ErrorEvent, GenerateRequest, TokenEvent, UiLang } from '../shared/api';
import { IPC } from '../shared/ipc';
import type { Engine } from './engine/types';
import { type EngineService, toUserError } from './engineService';
import { sanitizeImages } from './images';
import { msg, type MsgKey } from './messages';
import { maxImagesForContext } from './tuning';
import { assemblePrompt, loadPersonaFiles } from './persona';
import type { SettingsStore } from './storage';

export interface ChatControllerDeps {
  host: Engine;
  engine: EngineService;
  settings: SettingsStore;
  personaDir: string;
  lang(): UiLang;
  log?: (...args: unknown[]) => void;
}

/** Why a projector-equipped model cannot read images right now (see LoadedInfo.visionNote). */
function noVisionKey(note: string | undefined): MsgKey {
  switch (note) {
    case 'blocked':
      return 'noVisionBlocked';
    case 'unavailable':
      return 'noVisionUnavailable';
    case 'failed':
      return 'noVisionFailed';
    case 'projector':
      return 'noVisionProjector';
    default:
      return 'noVision';
  }
}

interface ActiveRequest {
  requestId: string;
  cancelled: boolean;
  /** Resolves when the request has fully finished (done / error / stopped). */
  finished: Promise<void>;
  finish(): void;
}

const MAX_MESSAGES = 400;
const MAX_CHARS_PER_MESSAGE = 200_000;

export class ChatController {
  private current: ActiveRequest | undefined;

  constructor(private readonly deps: ChatControllerDeps) {}

  /** Starts a generation and returns immediately; tokens/done/error are pushed to `sender`. */
  async generate(sender: WebContents, req: GenerateRequest): Promise<{ requestId: string }> {
    const requestId = randomUUID();
    const messages = Array.isArray(req?.messages)
      ? req.messages.slice(-MAX_MESSAGES).map((m) => ({
          role: m?.role === 'assistant' || m?.role === 'system' ? m.role : ('user' as const),
          content: typeof m?.content === 'string' ? m.content.slice(0, MAX_CHARS_PER_MESSAGE) : '',
          images: m?.role === 'user' ? sanitizeImages(m.images) : []
        }))
      : [];

    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active: ActiveRequest = { requestId, cancelled: false, finished, finish };

    const previous = this.current;
    this.current = active;
    void this.run(sender, active, messages, previous);
    return { requestId };
  }

  stop(requestId: string): void {
    const cur = this.current;
    if (cur && cur.requestId === requestId) {
      cur.cancelled = true;
      this.deps.host.abort(requestId);
    }
  }

  /** Aborts whatever is running (used before unloading/switching models and on quit). */
  async stopAll(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    cur.cancelled = true;
    this.deps.host.abort(cur.requestId);
    await Promise.race([cur.finished, new Promise((r) => setTimeout(r, 3000))]);
  }

  private async run(
    sender: WebContents,
    active: ActiveRequest,
    messages: GenerateRequest['messages'],
    previous: ActiveRequest | undefined
  ): Promise<void> {
    const { requestId } = active;
    const send = <T>(channel: string, payload: T): void => {
      if (!sender.isDestroyed()) sender.send(channel, payload);
    };
    const settle = (): void => {
      if (this.current === active) this.current = undefined;
      active.finish();
    };
    const lang = this.deps.lang();

    try {
      if (previous) {
        previous.cancelled = true;
        this.deps.host.abort(previous.requestId);
        await Promise.race([previous.finished, new Promise((r) => setTimeout(r, 5000))]);
      }
      await this.deps.engine.ensureLoaded();

      if (active.cancelled) {
        send<DoneEvent>(IPC.evChatDone, { requestId, text: '', stopped: true });
        settle();
        return;
      }

      const settings = await this.deps.settings.get();
      const files = await loadPersonaFiles(this.deps.personaDir);
      const info = this.deps.host.getLoadedInfo();
      // Images: only for a vision engine, and no more per message than the context window of THIS machine can hold.
      const newest = messages[messages.length - 1];
      const newImages = newest && newest.role === 'user' ? (newest.images?.length ?? 0) : 0;
      const hasAnyImage = messages.some((m) => (m.images?.length ?? 0) > 0);
      if (hasAnyImage && !info?.vision) {
        send<ErrorEvent>(IPC.evChatError, { requestId, message: msg(noVisionKey(info?.visionNote), lang) });
        settle();
        return;
      }
      const maxImages = maxImagesForContext(info?.contextSize ?? 4096);
      if (newImages > maxImages) {
        send<ErrorEvent>(IPC.evChatError, { requestId, message: msg('tooManyImages', lang, String(maxImages)) });
        settle();
        return;
      }
      const { systemPrompt, turns } = assemblePrompt({
        files,
        dialect: settings.dialect,
        history: messages,
        maxImages
      });
      if (turns.length === 0) {
        send<ErrorEvent>(IPC.evChatError, { requestId, message: msg('generateFailed', lang, 'empty message') });
        settle();
        return;
      }
      if (active.cancelled) {
        send<DoneEvent>(IPC.evChatDone, { requestId, text: '', stopped: true });
        settle();
        return;
      }
      this.deps.host.generate(
        requestId,
        { systemPrompt, turns, sampling: { temperature: settings.temperature, maxTokens: settings.maxTokens } },
        {
          onToken: (chunk) => send<TokenEvent>(IPC.evChatToken, { requestId, chunk }),
          onDone: (e) => {
            send<DoneEvent>(IPC.evChatDone, {
              requestId,
              text: e.text,
              tokensPerSecond: e.tokensPerSecond,
              stopped: e.stopped || undefined
            });
            settle();
          },
          onError: (e) => {
            let message: string;
            if (e.code === 'crashed') message = msg('engineCrashed', lang);
            else if (e.code === 'busy') message = msg('busy', lang);
            else if (e.code === 'no-model') message = msg('noModel', lang);
            else if (e.code === 'context') message = msg('generateFailed', lang, e.message);
            else message = msg('generateFailed', lang, e.message);
            send<ErrorEvent>(IPC.evChatError, { requestId, message });
            settle();
          }
        }
      );
    } catch (err) {
      this.deps.log?.('generate failed', err);
      const e = toUserError(err, lang, 'generateFailed');
      send<ErrorEvent>(IPC.evChatError, { requestId, message: e.message });
      settle();
    }
  }
}
