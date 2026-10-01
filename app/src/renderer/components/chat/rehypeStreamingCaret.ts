// Tiny rehype plugin: appends <span class="stream-caret"> to the very last text-bearing
// node of the document, so the blinking caret sits right after the last streamed character
// (inside the last paragraph / list item / code line) instead of on its own line.

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const isBlank = (n: HastNode) => n.type === 'text' && !(n.value ?? '').trim();

/** last child that is an element or non-blank text */
function lastMeaningful(node: HastNode): HastNode | undefined {
  const kids = node.children ?? [];
  for (let i = kids.length - 1; i >= 0; i--) {
    const k = kids[i]!;
    if (k.type === 'element' || (k.type === 'text' && !isBlank(k))) return k;
  }
  return undefined;
}

const STOP_DESCENT = new Set(['table', 'hr', 'img', 'br', 'input']);

export function rehypeStreamingCaret() {
  return (tree: unknown) => {
    let target = tree as HastNode;
    for (;;) {
      const last = lastMeaningful(target);
      if (!last || last.type === 'text') break;
      if (last.tagName && STOP_DESCENT.has(last.tagName)) break;
      target = last;
    }
    if (!target.children) target.children = [];
    target.children.push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['stream-caret'], ariaHidden: 'true' },
      children: [],
    });
  };
}
