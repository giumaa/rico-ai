// Streaming filter that removes <think>…</think> blocks (Qwen3-style hybrid reasoning) from model output,
// correctly handling tags split across chunk boundaries. Pure logic.

const OPEN = '<think>';
const CLOSE = '</think>';

/** Length of the longest suffix of `s` that is a proper prefix of `tag` (a possibly incomplete tag at the end). */
function partialTagSuffix(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

export class ThinkFilter {
  private buf = '';
  private inThink: boolean;
  private skipLeadingWs = false;

  /** @param startInThink true when the generation prompt already opened a think block. */
  constructor(startInThink = false) {
    this.inThink = startInThink;
  }

  /** Feeds a chunk, returns the visible text that can be emitted now. */
  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      if (this.inThink) {
        const i = this.buf.indexOf(CLOSE);
        if (i === -1) {
          // Discard thought text but keep a possible partial "</think" tail.
          const keep = partialTagSuffix(this.buf, CLOSE);
          this.buf = keep > 0 ? this.buf.slice(this.buf.length - keep) : '';
          return out;
        }
        this.buf = this.buf.slice(i + CLOSE.length);
        this.inThink = false;
        this.skipLeadingWs = true;
        continue;
      }
      if (this.skipLeadingWs) {
        const trimmed = this.buf.replace(/^\s+/, '');
        if (trimmed.length === 0) {
          this.buf = '';
          return out; // still only whitespace after </think>
        }
        this.buf = trimmed;
        this.skipLeadingWs = false;
      }
      const i = this.buf.indexOf(OPEN);
      if (i === -1) {
        const keep = partialTagSuffix(this.buf, OPEN);
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = keep > 0 ? this.buf.slice(this.buf.length - keep) : '';
        return out;
      }
      out += this.buf.slice(0, i);
      this.buf = this.buf.slice(i + OPEN.length);
      this.inThink = true;
    }
  }

  /** End of stream: emits any held-back text that turned out not to be a tag. */
  flush(): string {
    const rest = this.inThink ? '' : this.buf;
    this.buf = '';
    return rest;
  }
}

/** Convenience for non-streaming text. */
export function stripThinking(text: string): string {
  const f = new ThinkFilter();
  return f.push(text) + f.flush();
}
