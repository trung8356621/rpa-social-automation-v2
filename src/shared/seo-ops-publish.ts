import type { Manifest } from "./admin-v3.js";
import type { ScriptPublishBody } from "./script-release.js";
import { assertScriptPublishBody } from "./script-release.js";

/** Legacy V3 ZIP transport (Widget/Workflow local packages). */
export type PublishSubmission = {
  manifest: Manifest;
  packageBytes: Uint8Array;
  previewMetadata: Manifest["previews"];
  idempotencyKey: string;
};
export type PublishReceipt = {
  receiptId: string;
  releaseId: string;
  version: string;
  status: "accepted" | "rejected";
  reason?: string;
  receivedAt: string;
};
export interface SeoOpsPublisher {
  publish(submission: PublishSubmission): Promise<PublishReceipt>;
}

export function validateReceipt(submission: PublishSubmission, receipt: PublishReceipt) {
  if (
    !receipt ||
    !receipt.receiptId ||
    receipt.releaseId !== submission.manifest.releaseId ||
    receipt.version !== submission.manifest.version ||
    !["accepted", "rejected"].includes(receipt.status) ||
    !Number.isFinite(Date.parse(receipt.receivedAt)) ||
    (receipt.status === "rejected" && !receipt.reason)
  )
    throw new Error("SEO_OPS_RECEIPT: Receipt does not match the submitted immutable release.");
  return receipt;
}

/** Script Registry transport — JSON body matching SEO-OPS PackagePublishValidator. */
export type ScriptPublishSubmission = {
  body: ScriptPublishBody;
  contentDigest?: string;
  idempotencyKey: string;
};

export type ScriptPublishReceipt = {
  outcome: "created" | "idempotent" | "conflict" | "validation" | "unavailable";
  release?: {
    package_key: string;
    kind: "script";
    version: string;
    content_digest: string;
    idempotent?: boolean;
  };
  errors?: string[];
  httpStatus: number;
  receivedAt: string;
};

export interface SeoOpsScriptPublisher {
  publishScript(submission: ScriptPublishSubmission): Promise<ScriptPublishReceipt>;
}

export function validateScriptSubmission(submission: ScriptPublishSubmission) {
  assertScriptPublishBody(submission.body);
  if (!submission.idempotencyKey) throw new Error("SEO_OPS_SCRIPT: idempotencyKey required");
  return submission;
}

/**
 * HTTP Script publisher (no production upload by default).
 * Caller supplies baseUrl + bearer; never auto-targets production allowlist hosts.
 */
export function createHttpScriptPublisher(options: {
  baseUrl: string;
  serviceSlug: string;
  bearerToken: string;
  fetchImpl?: typeof fetch;
}): SeoOpsScriptPublisher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/$/, "")}/api/v1/services/${options.serviceSlug}/social-automation/packages/publish`;

  return {
    async publishScript(submission) {
      validateScriptSubmission(submission);
      const payload = {
        ...submission.body,
        ...(submission.contentDigest ? { content_digest: submission.contentDigest } : {}),
      };
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.bearerToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": submission.idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const outcome =
        (typeof json.outcome === "string" && json.outcome) ||
        (response.ok ? "created" : response.status === 409 ? "conflict" : "validation");
      return {
        outcome: outcome as ScriptPublishReceipt["outcome"],
        release: json.release as ScriptPublishReceipt["release"],
        errors: Array.isArray(json.errors) ? (json.errors as string[]) : undefined,
        httpStatus: response.status,
        receivedAt: new Date().toISOString(),
      };
    },
  };
}
