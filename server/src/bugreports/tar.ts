import { gzipSync } from 'node:zlib';

// A gzipped tar of a few small files (a problem report's folder), written
// here: no dependency for 40 lines. Plain ustar entries, names under 100
// bytes, regular files only.

function header(name: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, at: number, len: number) => h.write(s, at, len, 'ascii');
  const octal = (n: number, len: number) => `${n.toString(8).padStart(len - 1, '0')}\0`;
  put(name, 0, 100);
  put(octal(0o600, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(mtime / 1000), 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

export function tarGz(files: { name: string; data: Buffer }[], mtime: number): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    if (Buffer.byteLength(f.name) >= 100) throw new Error(`name too long for tar: ${f.name}`);
    parts.push(header(f.name, f.data.length, mtime), f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
