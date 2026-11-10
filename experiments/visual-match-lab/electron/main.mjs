import { app, BrowserWindow, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..', '..');
const descriptorPath = path.join(projectRoot, '.local', 'creator', 'visual-match-lab-bridge.json');
const devUrl = process.env.VISUAL_MATCH_LAB_URL || 'http://localhost:5180';

async function bridgeRequest(operation, payload = {}) {
  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  } catch {
    throw new Error('CREATOR_BROWSERCORE_UNAVAILABLE: Start RPA Creator V2 and open its Facebook BrowserCore.');
  }
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/${operation}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => { throw new Error('CREATOR_BRIDGE_UNREACHABLE: Restart Creator V2; no fallback browser was opened.'); });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Creator bridge request failed.');
  return result;
}

app.whenReady().then(async () => {
  const shell = new BrowserWindow({
    width: 1280, height: 960, minWidth: 900, minHeight: 650,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await shell.loadURL(devUrl);
});

ipcMain.handle('live-dom:state', () => bridgeRequest('state'));
ipcMain.handle('live-dom:capture', () => bridgeRequest('capture'));
ipcMain.handle('live-dom:inspect', (_event, request) => bridgeRequest('inspect', request));
ipcMain.handle('live-dom:parent', (_event, request) => bridgeRequest('parent', request));
ipcMain.handle('live-dom:highlight', (_event, request) => bridgeRequest('highlight', request));
ipcMain.handle('live-dom:scroll', (_event, request) => bridgeRequest('scroll', request));
app.on('window-all-closed', () => app.quit());
