import { describe, expect, it } from 'vitest';
import { stripThinking, ThinkFilter } from './thinkFilter';

function run(chunks: string[], startInThink = false): string {
  const f = new ThinkFilter(startInThink);
  return chunks.map((c) => f.push(c)).join('') + f.flush();
}

describe('ThinkFilter', () => {
  it('passes plain text through untouched', () => {
    expect(run(['مرحبا ', 'بك'])).toBe('مرحبا بك');
  });

  it('removes a think block and the blank space after it', () => {
    expect(run(['<think>reasoning here</think>\n\nHello'])).toBe('Hello');
  });

  it('handles tags split across chunk boundaries', () => {
    expect(run(['<th', 'ink>secret', ' stuff</thi', 'nk>', '\n', 'Answer'])).toBe('Answer');
    expect(run(['Before <', 'think>x</think> after'])).toBe('Before after');
  });

  it('removes multiple blocks', () => {
    expect(run(['A<think>1</think>B<think>2</think>C'])).toBe('ABC');
  });

  it('works character by character', () => {
    const text = '<think>hmm</think>Visible text';
    expect(run([...text])).toBe('Visible text');
  });

  it('keeps a lone "<" that is not a tag', () => {
    expect(run(['a < b and c <3'])).toBe('a < b and c <3');
    expect(run(['trailing <'])).toBe('trailing <');
  });

  it('drops an unterminated think block at the end of the stream', () => {
    expect(run(['Hi<think>never closed'])).toBe('Hi');
  });

  it('supports prompts that already opened the think block', () => {
    expect(run(['thoughts</think>Answer'], true)).toBe('Answer');
  });

  it('stripThinking works on whole strings', () => {
    expect(stripThinking('<think>a</think>b')).toBe('b');
  });
});
