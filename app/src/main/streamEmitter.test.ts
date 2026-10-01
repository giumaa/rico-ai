import { describe, expect, it } from 'vitest';
import { StreamEmitter } from './streamEmitter';

function setup(interval = 30) {
  let now = 1000;
  const sent: string[] = [];
  const e = new StreamEmitter((c) => sent.push(c), () => now, interval);
  return { e, sent, tick: (ms: number) => (now += ms) };
}

describe('StreamEmitter', () => {
  it('trims leading whitespace of the answer and strips think blocks', () => {
    const { e, sent } = setup();
    e.push('  \n');
    e.push('<think>secret</think>');
    e.push('\n\nHello');
    expect(e.finish()).toBe('Hello');
    expect(sent.join('')).toBe('Hello');
  });

  it('coalesces fast tokens (at most one event per interval) and flushes the rest at the end', () => {
    const { e, sent, tick } = setup(30);
    e.push('a'); // first send goes out immediately
    tick(5);
    e.push('b');
    tick(5);
    e.push('c');
    expect(sent).toEqual(['a']);
    tick(40);
    e.push('d');
    expect(sent).toEqual(['a', 'bcd']);
    e.push('e');
    expect(e.finish()).toBe('abcde');
    expect(sent.join('')).toBe('abcde');
  });

  it('holds back a possible partial tag until it is resolved', () => {
    const { e, sent } = setup(0);
    e.push('Hi <');
    e.push('b> there');
    expect(e.finish()).toBe('Hi <b> there');
    expect(sent.join('')).toBe('Hi <b> there');
  });

  it('drops an unterminated think block and returns trimmed full text', () => {
    const { e } = setup();
    e.push('Answer  ');
    e.push('<think>unfinished');
    expect(e.finish()).toBe('Answer');
  });
});
