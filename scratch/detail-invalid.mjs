import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const { Store } = await import(pathToFileURL(path.join(root, "dist/main/storage.js")).href);
const store = new Store(path.join(root, ".local/creator/creator.sqlite"));
const invalid = store.invalidSteps();
console.log(
  "invalidSteps",
  invalid.map((r) => ({
    flowId: r.flowId,
    stepId: r.stepId,
    version: r.version,
    reason: r.reason || r.message || r,
  })),
);
const detail = store.flows().find((f) => f.id === "facebook-group-post-detail");
console.log("detail flow", {
  id: detail?.id,
  name: detail?.name,
  tag: detail?.actionTagKey,
  steps: detail?.steps,
  variables: detail?.variables,
});
const step = store.step("d88c0075-32be-4a84-b655-edcacb2a853b", 1);
console.log("detail step payload keys", Object.keys(step.payload || {}));
console.log("detail step action", step.payload?.action, "name", step.name);
store.close();
