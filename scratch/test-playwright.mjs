import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "./playwright-runner/node_modules/playwright-core/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const screenshotPath = path.resolve(projectRoot, "scratch/electron-firstwindow.png");

let currentStep = "INITIALIZATION";
let electronApp = null;

try {
  currentStep = "STEP_1_LAUNCH_APP";
  console.log(`[${currentStep}] Launching Electron app without executablePath...`);
  
  electronApp = await _electron.launch({
    args: ["."],
    cwd: projectRoot,
    timeout: 30000,
  });
  console.log(`[${currentStep}] SUCCESS: Electron app launched`);

  currentStep = "STEP_2_GET_FIRST_WINDOW";
  console.log(`[${currentStep}] Waiting for firstWindow...`);
  const window = await electronApp.firstWindow({ timeout: 30000 });
  console.log(`[${currentStep}] SUCCESS: First window retrieved. Title: "${await window.title()}"`);

  currentStep = "STEP_3_CAPTURE_SCREENSHOT";
  console.log(`[${currentStep}] Taking screenshot to ${screenshotPath}...`);
  await window.waitForLoadState("domcontentloaded");
  await window.screenshot({ path: screenshotPath });
  console.log(`[${currentStep}] SUCCESS: Screenshot saved`);

  currentStep = "STEP_4_CLOSE_APP";
  console.log(`[${currentStep}] Closing Electron app...`);
  await electronApp.close();
  console.log(`[${currentStep}] SUCCESS: App closed`);

  currentStep = "COMPLETED";
  console.log(`ALL_STEPS_PASSED`);
  process.exit(0);
} catch (err) {
  console.error(`FAILED_AT_STEP: ${currentStep}`);
  console.error(`ERROR_MESSAGE: ${err.message}`);
  console.error(`ERROR_STACK: ${err.stack}`);
  if (electronApp) {
    try {
      await electronApp.close();
    } catch (_) {}
  }
  process.exit(1);
}
