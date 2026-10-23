import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
import { localOcr } from "../../src/main/ocr.ts";

const fp = ".local/creator/targets/884bfc4c-ba34-4b85-a642-5d76d1f7fd74.png";
const raw = readFileSync(fp);
const variants = {
  original: raw,
  contrast: await sharp(raw).normalize().linear(1.5, -30).png().toBuffer(),
  padded: await sharp(raw)
    .extend({ top: 40, bottom: 40, left: 20, right: 20, background: "white" })
    .png()
    .toBuffer(),
  upscale3: await sharp(raw)
    .resize({ width: 603 * 3, height: 52 * 3, kernel: "lanczos3" })
    .png()
    .toBuffer(),
  grayThresh: await sharp(raw)
    .grayscale()
    .normalize()
    .threshold(200)
    .png()
    .toBuffer(),
};

const out = [];
for (const [name, buf] of Object.entries(variants)) {
  const meta = await sharp(buf).metadata();
  try {
    // Bypass LocalOcr size path by calling recognize (height may exceed strip logic)
    const result = await localOcr.recognize(buf);
    out.push({
      name,
      width: meta.width,
      height: meta.height,
      rawText: result.text,
      confidence: result.confidence,
      lines: result.segments.filter((s) => s.kind === "line").map((s) => s.text),
    });
  } catch (error) {
    out.push({
      name,
      width: meta.width,
      height: meta.height,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  console.log(name, out.at(-1).rawText || out.at(-1).error || "(empty)");
}
await localOcr.close();
writeFileSync(
  "scripts/dev/ocr-diagnose-case-d-variants-out.json",
  JSON.stringify(out, null, 2),
);
