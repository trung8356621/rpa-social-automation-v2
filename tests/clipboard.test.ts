import test from "node:test";
import assert from "node:assert/strict";
import { pasteWithClipboard } from "../src/main/clipboard-guard.js";
test("clipboard restores snapshot including non-text formats, even if paste throws", async () => {
  let current = { text: "old", html: "<b>old</b>", custom: "bytes" };
  const port = {
    read: async () => ({ ...current }),
    write: async (v: typeof current) => {
      current = v;
    },
    writeText: async (text: string) => {
      current = { text, html: "", custom: "" };
    },
    fingerprint: async (v: typeof current) => JSON.stringify(v),
  };
  const old = { ...current };
  assert.equal(
    (
      await pasteWithClipboard(
        port,
        "Tiếng Việt 👋\nDòng 2",
        () => {},
        () => {},
        async () => {},
      )
    ).clipboard,
    "restored",
  );
  assert.deepEqual(current, old);
  await assert.rejects(
    pasteWithClipboard(
      port,
      "draft",
      () => {
        throw Error("paste failed");
      },
      () => {},
      async () => {},
    ),
    /paste failed/,
  );
  assert.deepEqual(current, old);
});
test("clipboard does not overwrite a concurrent copy and aborts before touching clipboard if snapshot fails", async () => {
  let current = "old";
  let writes = 0;
  const port = {
    read: async () => current,
    write: async (v: string) => {
      current = v;
      writes++;
    },
    writeText: async (v: string) => {
      current = v;
      writes++;
    },
    fingerprint: async (v: string) => v,
  };
  const result = await pasteWithClipboard(
    port,
    "draft",
    () => {},
    () => {},
    async () => {
      current = "new user copy";
    },
  );
  assert.equal(result.clipboard, "changed");
  assert.equal(current, "new user copy");
  assert.equal(writes, 1);
  await assert.rejects(
    pasteWithClipboard(
      {
        ...port,
        read: async () => {
          throw Error("snapshot failed");
        },
      },
      "draft",
      () => {},
      () => {},
    ),
    /snapshot failed/,
  );
  assert.equal(writes, 1);
});
test("clipboard restoration failure is explicit and readiness loss prevents paste", async () => {
  let current = "old",
    pasted = false,
    checks = 0;
  const port = {
    read: async () => current,
    write: async () => {
      throw Error("locked");
    },
    writeText: async (v: string) => {
      current = v;
    },
    fingerprint: async (v: string) => v,
  };
  const result = await pasteWithClipboard(
    port,
    "draft",
    () => {
      pasted = true;
    },
    () => {},
    async () => {},
  );
  assert.equal(result.clipboard, "restore_failed");
  assert.ok(result.warning);
  assert.equal(pasted, true);
  pasted = false;
  await assert.rejects(
    pasteWithClipboard(
      port,
      "draft",
      () => {
        pasted = true;
      },
      () => {
        if (++checks > 1) throw Error("focus lost");
      },
      async () => {},
    ),
    /focus lost/,
  );
  assert.equal(pasted, false);
});
test("unknown clipboard ownership after write does not overwrite newer contents", async () => {
  let current = "old",
    reads = 0,
    restores = 0;
  const port = {
    read: async () => {
      if (++reads === 2) {
        current = "external copy";
        throw Error("cannot read ownership");
      }
      return current;
    },
    write: async (v: string) => {
      restores++;
      current = v;
    },
    writeText: async (v: string) => {
      current = v;
    },
    fingerprint: async (v: string) => v,
  };
  await assert.rejects(
    pasteWithClipboard(
      port,
      "draft",
      () => {},
      () => {},
      async () => {},
    ),
    /ownership/,
  );
  assert.equal(current, "external copy");
  assert.equal(restores, 0);
});
