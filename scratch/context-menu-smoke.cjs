/**
 * Ephemeral runtime smoke for BrowserCore-style context menu (Task A).
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const electron = require("electron");

if (!process.versions.electron) {
  const env = { ...process.env, ELECTRON_DISABLE_GPU: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__filename], { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true });
  const timer = setTimeout(() => {
    console.error("SMOKE_TIMEOUT");
    child.kill();
    process.exit(1);
  }, 25000);
  child.on("exit", (code) => {
    clearTimeout(timer);
    process.exit(code ?? 1);
  });
} else {
  const { app, BrowserWindow, clipboard, Menu } = require("electron");
  const { pathToFileURL } = require("node:url");

  const failTimer = setTimeout(() => {
    console.error(JSON.stringify({ ok: false, error: "inner-timeout" }));
    app.exit(1);
  }, 20000);

  app
    .whenReady()
    .then(async () => {
      const distMenu = path.join(__dirname, "..", "dist", "shared", "browser-context-menu.js");
      const mod = await import(pathToFileURL(distMenu).href);
      const { buildBrowserContextMenuSpec, isCopyableLinkUrl } = mod;

      const win = new BrowserWindow({
        show: false,
        width: 640,
        height: 480,
        webPreferences: { sandbox: true, backgroundThrottling: false },
      });
      const wc = win.webContents;
      let menuEvents = 0;
      let copiedFromMenu = null;

      wc.on("context-menu", (_e, params) => {
        menuEvents += 1;
        const spec = buildBrowserContextMenuSpec(params, {
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
        });
        Menu.buildFromTemplate(
          spec.map((item) =>
            item.type === "separator"
              ? { type: "separator" }
              : { label: item.label, enabled: item.enabled, click: () => {} },
          ),
        );
        // Same async path as BrowserCore.showContextMenu copy-link.
        void (async () => {
          if (isCopyableLinkUrl(params.linkURL)) {
            await clipboard.writeText(params.linkURL);
            copiedFromMenu = await clipboard.readText();
          }
        })();
      });

      const ANH = "https://www.facebook.com/groups/seovamarketing/posts/29327016206983816/";
      await wc.loadURL(
        "data:text/html," +
          encodeURIComponent(`<body style="margin:80px"><a id="a" href="${ANH}">link</a><p id="t">hello copy me</p></body>`),
      );
      await new Promise((r) => setTimeout(r, 400));
      const box = await wc.executeJavaScript(
        "(() => { const r=document.getElementById('a').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()",
      );
      wc.focus();
      wc.sendInputEvent({ type: "mouseMove", x: box.x, y: box.y });
      wc.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "right", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "right", clickCount: 1 });
      await new Promise((r) => setTimeout(r, 1200));

      // Selected-text Copy path (menu item presence + wc.copy()).
      await wc.executeJavaScript(`(() => {
        const p = document.getElementById('t');
        const range = document.createRange();
        range.selectNodeContents(p);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return sel.toString();
      })()`);
      const tbox = await wc.executeJavaScript(
        "(() => { const r=document.getElementById('t').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()",
      );
      let textMenuHasCopy = false;
      const onTextMenu = (_e, params) => {
        const spec = buildBrowserContextMenuSpec(params, {
          canGoBack: false,
          canGoForward: false,
        });
        textMenuHasCopy = spec.some((i) => i.type === "action" && i.id === "copy" && i.enabled);
      };
      wc.on("context-menu", onTextMenu);
      wc.sendInputEvent({ type: "mouseDown", x: tbox.x, y: tbox.y, button: "right", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x: tbox.x, y: tbox.y, button: "right", clickCount: 1 });
      await new Promise((r) => setTimeout(r, 800));
      wc.removeListener("context-menu", onTextMenu);

      const ok =
        menuEvents >= 1 &&
        copiedFromMenu === ANH &&
        textMenuHasCopy &&
        // Primary BrowserCore pattern: one persistent listener on createView webContents.
        // (smoke adds a temporary second listener above, then removes it.)
        wc.listenerCount("context-menu") === 1;

      const report = { ok, copiedFromMenu, textMenuHasCopy, menuEvents, listenerCount: wc.listenerCount("context-menu") };
      fs.writeFileSync(path.join(__dirname, "context-menu-smoke-out.txt"), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      clearTimeout(failTimer);
      win.destroy();
      app.exit(ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(JSON.stringify({ ok: false, error: String(err && err.stack ? err.stack : err) }));
      clearTimeout(failTimer);
      app.exit(1);
    });
}
