import { createElement, memo, useMemo, type HTMLAttributes, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { detectDir, nodeToText } from '../../lib/text';
import { CodeBlock } from './CodeBlock';
import { rehypeStreamingCaret } from './rehypeStreamingCaret';

/** react-markdown also passes the hast `node`; it must never reach the DOM. */
type DomProps = { node?: unknown } & HTMLAttributes<HTMLElement>;

/**
 * Block elements get dir="auto": every paragraph / list / heading / cell picks its own
 * direction from its first strong character, so mixed Arabic + English documents lay out
 * correctly line by line.
 */
const auto = (tag: string) =>
  function AutoDir({ node, ...rest }: DomProps) {
    void node;
    return createElement(tag, { dir: 'auto', ...rest });
  };

/** Containers (lists, quotes, tables): direction from the first strong character of their content. */
const container = (tag: string) =>
  function ContainerDir({ node, children, ...rest }: DomProps) {
    void node;
    return createElement(tag, { dir: detectDir(nodeToText(children)), ...rest }, children);
  };

const components: Components = {
  p: auto('p'),
  ul: container('ul'),
  ol: container('ol'),
  li: auto('li'),
  h1: auto('h1'),
  h2: auto('h2'),
  h3: auto('h3'),
  h4: auto('h4'),
  h5: auto('h5'),
  h6: auto('h6'),
  blockquote: container('blockquote'),
  th: auto('th'),
  td: auto('td'),
  pre: ({ node, children }: DomProps) => {
    void node;
    return <CodeBlock>{children}</CodeBlock>;
  },
  table: ({ node, children }: DomProps) => {
    void node;
    const dir = detectDir(nodeToText(children));
    return (
      <div className="md-table-wrap" dir={dir}>
        <table dir={dir}>{children}</table>
      </div>
    );
  },
  // Offline app: links are displayed but never navigated (CSP + will-navigate deny anyway).
  a: ({ node, children, href }: DomProps & { href?: string }) => {
    void node;
    return (
      <span className="md-link" title={href}>
        {children as ReactNode}
      </span>
    );
  },
  // No remote images: show the alt text instead of attempting a network fetch.
  img: ({ node, alt }: { node?: unknown; alt?: string }) => {
    void node;
    return alt ? <em>{alt}</em> : null;
  },
};

const remarkPlugins = [remarkGfm];
const highlightPlugin = [rehypeHighlight, { detect: false, ignoreMissing: true }] as const;

interface MarkdownProps {
  content: string;
  /** append the blinking caret after the last character */
  streaming?: boolean;
}

export const Markdown = memo(function Markdown({ content, streaming = false }: MarkdownProps) {
  const rehypePlugins = useMemo(
    () => (streaming ? [highlightPlugin, rehypeStreamingCaret] : [highlightPlugin]),
    [streaming],
  );
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins as never}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
