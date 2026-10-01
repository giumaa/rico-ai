import { describe, expect, it } from 'vitest';
import { dataUri, MAX_IMAGES_PER_MESSAGE, sanitizeImages } from './images';
import { limitImages, normalizeHistory, type Turn } from './persona';

const good = (id: string, mime = 'image/jpeg') => ({ id, mime, dataBase64: 'QUJDREVGR0g=', name: `${id}.jpg`, width: 640, height: 480 });

describe('sanitizeImages', () => {
  it('keeps well-formed attachments and drops everything else', () => {
    const out = sanitizeImages([
      good('a'),
      good('b', 'image/gif'),
      { id: 'c', mime: 'image/png', dataBase64: 'not base64!!' },
      { id: 'd', mime: 'image/png', dataBase64: 5 },
      null,
      'x',
      { mime: 'image/webp', dataBase64: 'QUJDREVGR0g=' }
    ]);
    expect(out.map((i) => i.id)).toEqual(['a', expect.stringMatching(/^img-/)]);
    expect(out[0]).toMatchObject({ mime: 'image/jpeg', name: 'a.jpg', width: 640, height: 480 });
  });

  it('strips a data: prefix and whitespace, and caps the number of images', () => {
    const [img] = sanitizeImages([{ id: 'a', mime: 'image/png', dataBase64: 'data:image/png;base64,QUJD REVG\nR0g=' }]);
    expect(img!.dataBase64).toBe('QUJDREVGR0g=');
    expect(dataUri(img!)).toBe('data:image/png;base64,QUJDREVGR0g=');
    expect(sanitizeImages(Array.from({ length: 20 }, (_, i) => good(`i${i}`)))).toHaveLength(MAX_IMAGES_PER_MESSAGE);
    expect(sanitizeImages('nope')).toEqual([]);
  });
});

describe('history with images', () => {
  it('keeps image-only user messages and merges images of consecutive user messages', () => {
    const turns = normalizeHistory([
      { role: 'user', content: '', images: [good('a') as never] },
      { role: 'user', content: 'what is it?', images: [good('b') as never] },
      { role: 'assistant', content: 'a cat' },
      { role: 'user', content: 'thanks' }
    ]);
    expect(turns).toHaveLength(3);
    expect(turns[0]!.content).toBe('what is it?');
    expect(turns[0]!.images!.map((i) => i.id)).toEqual(['a', 'b']);
    expect(turns[2]!.images).toBeUndefined();
  });

  it('ignores images on assistant messages and drops invalid ones', () => {
    const turns = normalizeHistory([
      { role: 'user', content: 'hi', images: [{ id: 'x', mime: 'image/png', dataBase64: '###' } as never] },
      { role: 'assistant', content: 'hello', images: [good('y') as never] },
      { role: 'user', content: 'ok' }
    ]);
    expect(turns[0]!.images).toBeUndefined();
    expect(turns[1]!.images).toBeUndefined();
  });

  it('keeps only the newest images in the prompt and marks omitted ones', () => {
    const imgs = (n: number, p: string) => Array.from({ length: n }, (_, i) => good(`${p}${i}`) as never);
    const turns: Turn[] = [
      { role: 'user', content: '', images: imgs(2, 'old') },
      { role: 'assistant', content: 'r1' },
      { role: 'user', content: 'second', images: imgs(3, 'mid') },
      { role: 'assistant', content: 'r2' },
      { role: 'user', content: 'third', images: imgs(2, 'new') }
    ];
    limitImages(turns, 4);
    expect(turns[4]!.images!.map((i) => i.id)).toEqual(['new0', 'new1']);
    expect(turns[2]!.images!.map((i) => i.id)).toEqual(['mid1', 'mid2']);
    expect(turns[0]!.images).toBeUndefined();
    expect(turns[0]!.content).toBe('[images omitted]');
  });
});
