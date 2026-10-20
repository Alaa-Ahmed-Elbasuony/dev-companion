// Generates the extension's PNG icons without external dependencies.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Coverage (0..1) of the icon shape at normalized coords, as [r,g,b,a]. */
function shade(x, y) {
  // Rounded square background.
  const r = 0.22;
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  if (Math.hypot(dx, dy) > r) return [0, 0, 0, 0];
  const d = Math.hypot(x - 0.5, y - 0.5);
  // White ring + dot: a "record" symbol.
  if (d < 0.15 || (d > 0.25 && d < 0.33)) return [255, 255, 255, 255];
  return [79, 70, 229, 255];
}

export function renderIcon(size) {
  const ss = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const px = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          for (let i = 0; i < 3; i++) acc[i] += px[i] * px[3];
          acc[3] += px[3];
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const a = acc[3] / (ss * ss);
      for (let i = 0; i < 3; i++) raw[o + i] = acc[3] ? Math.round(acc[i] / acc[3]) : 0;
      raw[o + 3] = Math.round(a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
