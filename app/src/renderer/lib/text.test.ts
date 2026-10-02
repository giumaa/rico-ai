import { describe, expect, it } from 'vitest';
import { firstSentence } from './text';

describe('firstSentence', () => {
  it('takes the first sentence of Arabic and English replies', () => {
    expect(firstSentence('أهلا بيك! شن نقدر نساعدك فيه اليوم؟')).toBe('أهلا بيك!');
    expect(firstSentence('Sure. Here is the plan: first, then second.')).toBe('Sure.');
    expect(firstSentence('كيف الحال؟ تمام')).toBe('كيف الحال؟');
  });
  it('ignores markdown noise and code fences, and falls back to the first line', () => {
    expect(firstSentence('**Done** and dusted\nmore text here')).toBe('Done and dusted');
    expect(firstSentence('```js\nconst a = 1;\n```\nThat is all.')).toBe('That is all.');
  });
  it('caps very long first sentences and does not split decimals', () => {
    expect(firstSentence('Pi is 3.14 and so on')).toBe('Pi is 3.14 and so on');
    const long = 'word '.repeat(100);
    expect(firstSentence(long, 40).length).toBeLessThanOrEqual(41);
  });
});
