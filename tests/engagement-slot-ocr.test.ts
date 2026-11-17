import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { recognizeEngagementSlots } from "../src/main/engagement-slot-ocr";
import type { OcrResult } from "../src/shared/contracts";

type LocalOcr = {
  recognize: (image: Buffer) => Promise<OcrResult>;
  close?: () => Promise<void>;
};

async function loadLocalOcr(): Promise<LocalOcr> {
  const mod = await import(pathToFileURL(path.join(process.cwd(), "dist/main/ocr.js")).href) as {
    localOcr: LocalOcr;
  };
  return mod.localOcr;
}

test("icon-slot OCR: 19/7/3 full row → coverage 3/3", async () => {
  const cropPath = path.join(process.cwd(), "scratch/post-detail-runs/pd_20261116T170031Z_00up2a/engagement-ocr/29362527793432657/engagement.png");
  const crop = await readFile(cropPath);
  const localOcr = await loadLocalOcr();
  const result = await recognizeEngagementSlots({ crop, localOcr });
  const map = Object.fromEntries(result.digits.map(digit => [digit.field, digit.value]));
  assert.equal(map.like_count, 19);
  assert.equal(map.comment_count, 7);
  assert.equal(map.share_count, 3);
  assert.equal(result.digits.length, 3);
  await localOcr.close?.();
});

test("icon-slot OCR: icon-only Like/Comment + Share 1 → coverage 1/3", async () => {
  const cropPath = path.join(process.cwd(), "scratch/post-detail-runs/pd_20261117T041631_engagement/engagement-ocr/29363132623372174/engagement.png");
  const crop = await readFile(cropPath);
  const localOcr = await loadLocalOcr();
  const result = await recognizeEngagementSlots({ crop, localOcr });
  const map = Object.fromEntries(result.digits.map(digit => [digit.field, digit.value]));
  assert.equal(map.like_count, undefined);
  assert.equal(map.comment_count, undefined);
  assert.equal(map.share_count, 1);
  assert.equal(result.digits.length, 1);
  assert.match(result.diagnostics.join("\n"), /ICON_ONLY_NO_COUNT/);
  await localOcr.close?.();
});
