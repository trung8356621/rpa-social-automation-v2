import { createHash } from "node:crypto";
import { phpCompatibleJsonEncode } from "./canonicalJson.js";

/** Field order MUST match Social Automation PackagePublishValidator.php */
export type CanonicalPackagePayload = {
  package_key: string;
  kind: string;
  version: string;
  schema_version: number;
  manifest: Record<string, unknown>;
  dependencies: Array<{
    package_key: string;
    version: string;
    content_digest: string;
  }>;
  runtime_compatibility: Record<string, unknown>;
};

export function buildCanonicalPayload(
  input: CanonicalPackagePayload,
): CanonicalPackagePayload {
  return {
    package_key: input.package_key,
    kind: input.kind,
    version: input.version,
    schema_version: input.schema_version,
    manifest: input.manifest,
    dependencies: input.dependencies ?? [],
    runtime_compatibility: input.runtime_compatibility ?? {},
  };
}

export function sha256OfCanonicalPayload(
  canonical: CanonicalPackagePayload,
): string {
  return createHash("sha256")
    .update(phpCompatibleJsonEncode(canonical), "utf8")
    .digest("hex");
}

export function isValidDigestHex(digest: string): boolean {
  return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest);
}

export function digestsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}
