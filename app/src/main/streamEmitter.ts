// Shared "model text -> UI chunks" pipeline: strips <think> blocks, trims the leading whitespace of the answer and
// coalesces tiny pieces so the renderer receives at most ~33 events per second. Pure (injectable clock).

import { ThinkFilter } from './thinkFilter';

export class StreamEmitter {
  private readonly filter = new ThinkFilter();
  private started = false;
  private pending = '';
  private lastSend = 0;
  /** Everything emitted so far (the final answer text). */
  full = '';

  constructor(
    private readonly send: (chunk: string) => void,
    private readonly now: () => number = Date.now,
    private readonly intervalMs = 30
  ) {}

  /** Feed raw model output. */
  push(raw: string): void {
    this.add(this.filter.push(raw));
  }

  private add(text: string): void {
    if (!text) return;
    if (!this.started) {
      text = text.replace(/^\s+/, '');
      if (!text) return;
      this.started = true;
    }
    this.full += text;
    this.pending += text;
    this.flushPending(false);
  }

  private flushPending(force: boolean): void {
    if (!this.pending) return;
    const t = this.now();
    if (!force && t - this.lastSend < this.intervalMs) return;
    this.send(this.pending);
    this.pending = '';
    this.lastSend = t;
  }

  /** End of stream: releases held-back text and sends whatever is still buffered. */
  finish(): string {
    this.add(this.filter.flush());
    this.flushPending(true);
    return this.full.trimEnd();
  }
}
