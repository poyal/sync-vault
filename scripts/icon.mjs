import fs from "node:fs";
import { deflateSync } from "node:zlib";
export function makeIcon() {
  const n = 512,
    raw = Buffer.alloc(n * (n * 4 + 1));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const px = x / n,
        py = y / n,
        corner = Math.hypot(
          Math.max(0.18 - px, 0, px - 0.82),
          Math.max(0.18 - py, 0, py - 0.82),
        );
      const arrow = (a, b) =>
        (a > 0.23 && a < 0.72 && Math.abs(b - 0.35) < 0.034) ||
        (a >= 0.6 && a <= 0.79 && Math.abs(b - 0.35) < (0.79 - a) * 0.94);
      const bright = arrow(px, py) || arrow(1 - px, 1 - py),
        o = y * (n * 4 + 1) + 1 + x * 4;
      raw[o] = bright ? 192 : 25;
      raw[o + 1] = bright ? 248 : 63;
      raw[o + 2] = bright ? 204 : 51;
      raw[o + 3] = Math.round(
        255 * Math.max(0, Math.min(1, (0.18 - corner) * n)),
      );
    }
  function part(name, data) {
    const type = Buffer.from(name),
      b = Buffer.alloc(data.length + 12);
    b.writeUInt32BE(data.length);
    type.copy(b, 4);
    data.copy(b, 8);
    let crc = -1;
    for (const v of Buffer.concat([type, data])) {
      crc ^= v;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    b.writeUInt32BE(~crc >>> 0, b.length - 4);
    return b;
  }
  const hdr = Buffer.alloc(13);
  hdr.writeUInt32BE(n);
  hdr.writeUInt32BE(n, 4);
  hdr[8] = 8;
  hdr[9] = 6;
  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync(
    "out/icon.png",
    Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      part("IHDR", hdr),
      part("IDAT", deflateSync(raw)),
      part("IEND", Buffer.alloc(0)),
    ]),
  );
}
