import { describe, expect, it } from 'vitest';
import { releaseImage } from '../../src/docker/changelog.js';

// Pictures in release notes through Burrow (report 64498b): only from
// GitHub, following GitHub's own redirects, raster images up to 5 MB.
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const reply = (status: number, headers: Record<string, string>, body: Buffer | string = '') => new Response(status >= 300 && status < 400 ? null : typeof body === 'string' ? body : new Uint8Array(body), { status, headers });

describe('release note pictures', () => {
  it('fetched through GitHub redirects to its attachment storage, kept, served with their type', async () => {
    const asked: string[] = [];
    const fetch = async (url: string) => {
      asked.push(url);
      if (url.startsWith('https://github.com/')) return reply(302, { location: 'https://github-production-user-asset-6210df.s3.amazonaws.com/1/a.png?sig=x' });
      return reply(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) }, PNG);
    };
    const url = 'https://github.com/user-attachments/assets/b011c1a2-b81c-47a8-b3d8-159d829fcf82';
    const img = await releaseImage(url, { fetch, now: 1000 });
    expect(img).toMatchObject({ type: 'image/png' });
    expect(img.bytes.equals(PNG)).toBe(true);
    expect(asked).toEqual([url, 'https://github-production-user-asset-6210df.s3.amazonaws.com/1/a.png?sig=x']);
    // Kept: not fetched again within a day.
    await releaseImage(url, { fetch, now: 2000 });
    expect(asked).toHaveLength(2);
  });

  it('refuses what is not GitHub, redirects elsewhere, SVG and other types, and pictures over 5 MB', async () => {
    const never = async () => {
      throw new Error('fetched');
    };
    await expect(releaseImage('https://example.com/a.png', { fetch: never })).rejects.toMatchObject({ status: 400 });
    await expect(releaseImage('http://raw.githubusercontent.com/a/b/main/x.png', { fetch: never })).rejects.toMatchObject({ status: 400 });
    await expect(releaseImage('https://github.com/login', { fetch: never })).rejects.toMatchObject({ status: 400 });
    const to = (location: string) => async () => reply(302, { location });
    await expect(releaseImage('https://raw.githubusercontent.com/a/b/main/1.png', { fetch: to('http://169.254.169.254/latest') })).rejects.toThrow(/elsewhere/);
    const typed = (type: string, size = 10) => async () => reply(200, { 'content-type': type, 'content-length': String(size) }, Buffer.alloc(Math.min(size, 16)));
    await expect(releaseImage('https://raw.githubusercontent.com/a/b/main/2.svg', { fetch: typed('image/svg+xml') })).rejects.toThrow(/Not a picture/);
    await expect(releaseImage('https://raw.githubusercontent.com/a/b/main/3.html', { fetch: typed('text/html') })).rejects.toThrow(/Not a picture/);
    await expect(releaseImage('https://raw.githubusercontent.com/a/b/main/4.png', { fetch: typed('image/png', 6 << 20) })).rejects.toThrow(/5 MB/);
    await expect(releaseImage('https://raw.githubusercontent.com/a/b/main/5.png', { fetch: async () => reply(404, {}) })).rejects.toThrow(/HTTP 404/);
  });

  it('stops reading a chunked picture at 5 MB instead of taking it whole (A3-SRV-16)', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1 << 20);
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += chunk.length;
        if (pulled > 64 << 20) c.close();
        else c.enqueue(chunk);
      },
    });
    const fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    await expect(releaseImage('https://raw.githubusercontent.com/a/b/main/chunked.png', { fetch })).rejects.toThrow(/5 MB/);
    expect(pulled).toBeLessThan(8 << 20);
  });
});
