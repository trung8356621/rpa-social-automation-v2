import { Store } from "../src/main/storage.ts";
import { TestLab } from "../src/main/test-lab.ts";
import { BrowserSessions } from "../src/main/browser-sessions.ts";

const store = new Store(".local/creator/creator.sqlite");
const sessions = new BrowserSessions(store);
const lab = new TestLab(store, sessions);

const flows = store.flows();
console.log(
  "FLOWS",
  flows.map((f) => ({
    id: f.id,
    name: f.name,
    startUrl: f.startUrl,
    steps: f.steps.length,
    tag: f.actionTagKey,
  })),
);

const poc =
  flows.find((f) => /POC 3/i.test(f.name)) ||
  flows.find((f) => f.steps.length === 7 && /facebook/i.test(f.name));

if (!poc) {
  console.log("NO_POC");
  store.close();
  process.exit(0);
}

console.log(
  "POC",
  JSON.stringify(
    {
      id: poc.id,
      name: poc.name,
      startUrl: poc.startUrl,
      tag: poc.actionTagKey,
      pins: poc.steps,
    },
    null,
    2,
  ),
);

try {
  store.assertFlowExecutable(poc);
  console.log("assertFlowExecutable PASS");
} catch (e) {
  console.log("assertFlowExecutable FAIL", String(e?.message || e).slice(0, 800));
}

for (const ref of poc.steps) {
  const step = store.step(ref.id, ref.version);
  try {
    store.assertStepExecutable(ref.id, ref.version, poc);
    console.log(
      "OK",
      ref.id.slice(0, 8),
      `v${ref.version}`,
      step.name,
      step.payload.action,
      step.payload.target?.asset ? "asset" : "no-asset",
      step.payload.variableId || "",
    );
  } catch (e) {
    console.log(
      "BAD",
      ref.id.slice(0, 8),
      `v${ref.version}`,
      step.name,
      step.payload.action,
      String(e?.message || e).slice(0, 400),
    );
  }
}

const cases = lab.read().cases.filter((c) => c.flowId === poc.id);
console.log(
  "CASES",
  JSON.stringify(
    cases.map((c) => ({
      id: c.id,
      name: c.name,
      startUrl: c.startUrl,
      sessionId: c.sessionId,
      pins: c.stepVersions,
      last: c.lastResult && {
        status: c.lastResult.status,
        message: String(c.lastResult.message || "").slice(0, 300),
        screenshotError: c.lastResult.screenshotError,
        stepId: c.lastResult.stepId,
        version: c.lastResult.version,
        runId: c.lastResult.runId,
      },
    })),
    null,
    2,
  ),
);

for (const c of cases) {
  try {
    const flow = structuredClone(lab.validate({ ...c, startUrl: c.startUrl || poc.startUrl || "" }, false));
    console.log("CASE pins", c.name, flow.steps);
    for (const ref of flow.steps) store.assertStepExecutable(ref.id, ref.version, flow);
    console.log("CASE preflight PASS", c.name);
  } catch (e) {
    console.log("CASE preflight FAIL", c.name, String(e?.message || e).slice(0, 500));
  }
}

store.close();
