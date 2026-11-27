import { z } from "zod";
export const stampSchema = z
  .object({
    clock: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    origin: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const clipSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      stamp: stampSchema,
      text: z.string().max(2 * 1024 ** 2),
      html: z
        .string()
        .max(2 * 1024 ** 2)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image"),
      stamp: stampSchema,
      png: z.string().max(44 * 1024 ** 2),
    })
    .strict(),
]);
export type Clip = z.infer<typeof clipSchema>;
export function cleanHTML(input: string) {
  const tags = new Set(
    "p br div span b strong i em u s ul ol li blockquote pre code table thead tbody tr td th a".split(
      " ",
    ),
  );
  return input.replace(/<!--[\s\S]*?(?:-->|$)|<[^>]*>|</g, (tag) => {
    const m = /^<(\/?)\s*([a-z0-9]+)\b[^>]*>$/i.exec(tag);
    if (!m || !tags.has(m[2].toLowerCase())) return "";
    const name = m[2].toLowerCase();
    if (!m[1] && name === "a") {
      const h = /\shref\s*=\s*["'](https?:\/\/[^"'<>\s]+)["']/i.exec(tag);
      if (h) return '<a href="' + h[1].replaceAll("&", "&amp;") + '">';
    }
    return "<" + m[1] + name + ">";
  });
}
export function checkedPng(bytes: Buffer) {
  if (
    bytes.length < 24 ||
    bytes.length > 32 * 1024 ** 2 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw Error("올바른 PNG가 아닙니다.");
  const pixels = bytes.readUInt32BE(16) * bytes.readUInt32BE(20);
  if (!pixels || pixels > 48 * 1024 ** 2)
    throw Error("이미지 해상도가 너무 큽니다.");
  return bytes;
}
