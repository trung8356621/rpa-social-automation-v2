import test from "node:test";
import assert from "node:assert/strict";
import { errorDestination } from "../src/shared/error-navigation.js";

test("structured errors navigate to the exact Variable, otherwise the exact Step", () => {
  const base = { code: "UPLOAD_FILES_INVALID" as const, category: "Dữ liệu upload" as const,
    stepId: "step-3", version: 3, field: "files", message: "missing", suggestedAction: "fix" };
  assert.deepEqual(errorDestination({ ...base, variableId: "imgs" }), { kind: "variable", variableId: "imgs" });
  assert.deepEqual(errorDestination(base), { kind: "step", stepId: "step-3", version: 3 });
});
