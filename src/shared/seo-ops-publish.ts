import type { Manifest } from "./admin-v3.js";

/** Transport contract only. SEO-OPS must supply authentication, endpoint and limits. */
export type PublishSubmission = { manifest: Manifest; packageBytes: Uint8Array;
  previewMetadata: Manifest["previews"]; idempotencyKey: string };
export type PublishReceipt = { receiptId: string; releaseId: string; version: string;
  status: "accepted" | "rejected"; reason?: string; receivedAt: string };
export interface SeoOpsPublisher { publish(submission: PublishSubmission): Promise<PublishReceipt>; }
export function validateReceipt(submission: PublishSubmission, receipt: PublishReceipt) {
  if (!receipt || !receipt.receiptId || receipt.releaseId !== submission.manifest.releaseId || receipt.version !== submission.manifest.version
    || !["accepted", "rejected"].includes(receipt.status) || !Number.isFinite(Date.parse(receipt.receivedAt)) || receipt.status === "rejected" && !receipt.reason)
    throw new Error("SEO_OPS_RECEIPT: Receipt does not match the submitted immutable release.");
  return receipt;
}
