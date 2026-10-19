import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const electron = require("electron");
const phases = process.argv.slice(2);
if (
  phases.some(
    (phase) =>
      ![
        "overlay",
        "first",
        "second",
        "ux",
        "ocr",
        "typing",
        "upload",
        "address",
      ].includes(phase),
  )
) {
  throw new Error(
    "Supported browser test phases: overlay, first, second, ux, ocr, typing, upload, address",
  );
}
for (const phase of phases.length
  ? phases
  : [
      "overlay",
      "first",
      "second",
      "ux",
      "ocr",
      "typing",
      "upload",
      "address",
    ]) {
  const started = Date.now();
  const code = await new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [".", "--self-test", `--phase=${phase}`], {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Browser test timed out after 90s"));
    }, 90000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (code !== 0)
    throw new Error(`Browser test ${phase} failed (${code}); see artifacts/`);
  const report = JSON.parse(
    await readFile(path.join("artifacts", `browser-${phase}.json`), "utf8"),
  );
  if (Date.parse(report.timestamp) < started)
    throw new Error(
      "No fresh test report; another instance may hold the session lock.",
    );
  console.log(
    `BROWSER POC ${report.status.toUpperCase()}: ${report.passedCount} passed, ${report.pendingCount} limitations/manual checks (Facebook not tested).`,
  );
}
