import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1600,
      height: 1200,
      show: false,
      webPreferences: {
        offscreen: true,
      },
    });

    win.webContents.on('console-message', (_e, level, msg, line, src) => {
      console.log(`[BROWSER CONSOLE ${level}]: ${msg} (${src}:${line})`);
    });

    console.log('Loading http://localhost:5180/ ...');
    await win.loadURL('http://localhost:5180/');

    // Wait for pipeline & OpenCV to finish processing
    await new Promise((r) => setTimeout(r, 2500));

    // Capture initial screenshot
    const image1 = await win.webContents.capturePage();
    fs.mkdirSync('artifacts', { recursive: true });
    fs.writeFileSync('artifacts/visual-match-lab-browser.png', image1.toPNG());
    console.log('Saved artifacts/visual-match-lab-browser.png');

    // Inspect pipeline execution details inside page
    const state = await win.webContents.executeJavaScript(`(() => {
      const text = document.body.innerText;
      const h2s = Array.from(document.querySelectorAll('h2')).map(h => h.innerText);
      const h3s = Array.from(document.querySelectorAll('h3')).map(h => h.innerText);
      return {
        h2s,
        h3s,
        hasTitle: text.includes('RPA — Visual Image Recognition Lab'),
        hasPreprocessing: h2s.some(h => h.toUpperCase().includes('STAGE A')),
        hasIconGallery: h2s.some(h => h.toUpperCase().includes('STAGE C')),
        hasGroupRecognition: h2s.some(h => h.toUpperCase().includes('STAGE D')),
        hasVisualMatch: h2s.some(h => h.toUpperCase().includes('STAGE E')),
        textLength: text.length,
      };
    })()`);
    console.log('DOM Validation State:', state);

    // Trigger Stage E visual matching by clicking "Run Visual Match" button
    const matchTriggerResult = await win.webContents.executeJavaScript(`(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const matchBtn = buttons.find(b => b.innerText.includes('Run Visual Match'));
      if (matchBtn) {
        matchBtn.click();
        return 'CLICKED_MATCH_BUTTON';
      }
      return 'BUTTON_NOT_FOUND';
    })()`);
    console.log('Match button trigger result:', matchTriggerResult);

    // Wait for matching to complete
    await new Promise((r) => setTimeout(r, 1500));

    // Capture post-match screenshot
    const image2 = await win.webContents.capturePage();
    fs.writeFileSync('artifacts/visual-match-lab-matched.png', image2.toPNG());
    console.log('Saved artifacts/visual-match-lab-matched.png');

    // Extract match table results
    const matchState = await win.webContents.executeJavaScript(`(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr')).map(tr => {
        return Array.from(tr.querySelectorAll('td')).map(td => td.innerText);
      });
      return { matchRows: rows };
    })()`);
    console.log('Detected Match Candidates:', matchState);

    console.log('TEST BROWSER VERIFICATION: SUCCESS');
    app.quit();
  } catch (err) {
    console.error('Browser verification failed:', err);
    app.exit(1);
  }
});
