import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/main/storage.js";
import { createSeoOpsSyncService } from "../src/main/seo-ops-sync.js";
import type { ActionTag, Flow, Step } from "../src/shared/contracts.js";
import type { VideoDemoAttachment } from "../src/shared/video-demo.js";

function setupTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpa-active-script-sync-"));
  const dbFile = path.join(tmpDir, "creator.sqlite");
  const targetsDir = path.join(tmpDir, "targets");
  const testRunsDir = path.join(tmpDir, "test-runs");
  fs.mkdirSync(targetsDir, { recursive: true });
  fs.mkdirSync(testRunsDir, { recursive: true });
  const store = new Store(dbFile);
  let token: string | null = "test-token-active-sync";
  const tokenStore = {
    getToken: () => token,
    setToken: (t: string | null) => { token = t; },
  };
  const service = createSeoOpsSyncService({
    store,
    assetDir: targetsDir,
    tokenStore,
    dataPath: tmpDir,
    testRunsDir,
  });

  return { tmpDir, store, tokenStore, service, targetsDir, testRunsDir };
}

test("Mandatory Tests A-H: Sync Active Scripts and Demo Video from SEO-OPS to RPA Admin", async (t) => {
  const { tmpDir, store, tokenStore, service, targetsDir, testRunsDir } = setupTestEnv();

  // Test tag fixture
  const sampleTag: ActionTag = {
    id: 101,
    tag_key: "facebook.group.post",
    platform: "facebook",
    target: "group",
    action: "post",
    name: "Facebook Group Post",
    description: "Đăng bài trong nhóm Facebook",
  };

  const sampleTagNoScript: ActionTag = {
    id: 102,
    tag_key: "x.profile.post",
    platform: "x",
    target: "profile",
    action: "post",
    name: "X Profile Post",
    description: "Đăng bài trên X profile",
  };

  // Mock demo video & thumbnail data
  const mockVideoBufferV1 = Buffer.from("RIFF-WEBM-MOCK-VIDEO-DATA-RELEASE-V1-987654321");
  const mockVideoShaV1 = createHash("sha256").update(mockVideoBufferV1).digest("hex");
  const mockThumbBufferV1 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x01]);
  const mockThumbShaV1 = createHash("sha256").update(mockThumbBufferV1).digest("hex");

  const mockVideoBufferV2 = Buffer.from("RIFF-WEBM-MOCK-VIDEO-DATA-RELEASE-V2-NEW-RUN-112233");
  const mockVideoShaV2 = createHash("sha256").update(mockVideoBufferV2).digest("hex");
  const mockThumbBufferV2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x02]);
  const mockThumbShaV2 = createHash("sha256").update(mockThumbBufferV2).digest("hex");

  let currentVideoBuffer = mockVideoBufferV1;
  let currentVideoSha = mockVideoShaV1;
  let currentThumbBuffer = mockThumbBufferV1;
  let currentThumbSha = mockThumbShaV1;

  let videoDemoDownloads = 0;
  let thumbnailDownloads = 0;
  let videoDemo404 = false;
  let videoDemoCorrupt = false;

  // Active script v1 fixture with video_demo
  const activeScriptV1 = {
    action_tag_id: 101,
    action_tag_key: "facebook.group.post",
    script_id: "facebook-group-post",
    package_key: "facebook.group.post",
    version: "1.0.0",
    content_digest: "1111111111111111111111111111111111111111111111111111111111111111",
    execution_digest: "e111111111111111111111111111111111111111111111111111111111111111",
    name: "Facebook Group Post Standard",
    release: {
      package_key: "facebook.group.post",
      kind: "script",
      name: "Facebook Group Post Standard",
      version: "1.0.0",
      content_digest: "1111111111111111111111111111111111111111111111111111111111111111",
      execution_digest: "e111111111111111111111111111111111111111111111111111111111111111",
      schema_version: 1,
      manifest: {
        script_id: "facebook-group-post",
        action_tag_key: "facebook.group.post",
        action_tag_id: 101,
        variables: [
          { id: "var-content", key: "post_text", type: "text", description: "Nội dung bài viết" },
        ],
        steps: [
          {
            id: "step-1",
            version: 1,
            action: "TYPE_ONLY",
            name: "Nhập nội dung",
            variableId: "var-content",
            inputMethod: "keyboard",
          },
        ],
        default_pattern: {
          values: {
            "var-content": "Xin chào cộng đồng!",
          },
        },
        assets: [],
        video_demo: {
          artifact_ref: "demos/facebook-group-post/run-1/recording.webm",
          sha256: mockVideoShaV1,
          mime: "video/webm",
          test_run_id: "run-1",
          reviewed: true,
          thumbnail_ref: "demos/facebook-group-post/run-1/recording-thumb.jpg",
          thumbnail_sha256: mockThumbShaV1,
        },
      },
    },
  };

  let mockTags = [sampleTag, sampleTagNoScript];
  let mockActiveScripts: Array<unknown> = [activeScriptV1];
  let returnError = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (returnError) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, errors: ["server_error_database_offline"] }));
      return;
    }

    if (url.pathname === "/api/v1/social-automation/rpa-admin/action-tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, action_tags: mockTags }));
      return;
    }

    if (url.pathname === "/api/v1/social-automation/rpa-admin/active-scripts") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, active_scripts: mockActiveScripts }));
      return;
    }

    if (url.pathname === "/api/v1/social-automation/rpa-admin/scripts/video-demo") {
      if (videoDemo404) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, errors: ["media_not_found"] }));
        return;
      }

      const kind = url.searchParams.get("kind") || "video_demo";
      if (kind === "thumbnail") {
        thumbnailDownloads++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          kind: "thumbnail",
          mime: "image/jpeg",
          sha256: currentThumbSha,
          size_bytes: currentThumbBuffer.length,
          content_base64: currentThumbBuffer.toString("base64"),
        }));
        return;
      } else {
        videoDemoDownloads++;
        if (videoDemoCorrupt) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            kind: "video_demo",
            mime: "video/webm",
            sha256: currentVideoSha,
            size_bytes: 15,
            content_base64: Buffer.from("CORRUPT_BYTES").toString("base64"),
          }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          kind: "video_demo",
          mime: "video/webm",
          sha256: currentVideoSha,
          size_bytes: currentVideoBuffer.length,
          content_base64: currentVideoBuffer.toString("base64"),
        }));
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  service.setConfig(`http://127.0.0.1:${port}`);

  try {
    // -------------------------------------------------------------------------
    // TEST A: Active Script có video -> tải về thành công
    // -------------------------------------------------------------------------
    await t.test("TEST A: Active Script có video -> Tải về thành công cả Script, Steps và Demo Video", async () => {
      const res = await service.syncActionTags();
      assert.equal(res.ok, true);
      if (!res.ok) return;

      assert.equal(res.count, 2);
      assert.equal(res.scriptsCount, 1);

      // Verify Flow in SQLite
      const flows = store.flows();
      const flow = flows.find(f => f.actionTagKey === "facebook.group.post");
      assert.ok(flow, "Flow phải được tạo trong store");
      assert.equal(flow.id, "facebook-group-post");
      assert.equal(flow.name, "Facebook Group Post Standard");
      assert.equal(flow.actionTagId, 101);
      assert.equal(flow.actionTagKey, "facebook.group.post");
      assert.equal(flow.steps.length, 1);

      // Verify Steps in SQLite
      const step = store.step("step-1", 1);
      assert.ok(step, "Step phải được lưu trong bảng steps");

      // Verify Demo Video and Thumbnail downloaded to disk
      const videoPath = path.join(testRunsDir, "demos", "facebook-group-post", "run-1", "recording.webm");
      const thumbPath = path.join(testRunsDir, "demos", "facebook-group-post", "run-1", "recording-thumb.jpg");
      assert.ok(fs.existsSync(videoPath), "Video demo file phải tồn tại trên disk local");
      assert.ok(fs.existsSync(thumbPath), "Thumbnail demo file phải tồn tại trên disk local");
      assert.deepEqual(fs.readFileSync(videoPath), mockVideoBufferV1);
      assert.deepEqual(fs.readFileSync(thumbPath), mockThumbBufferV1);

      // Verify metadata setting
      const demoRaw = store.setting("videoDemo:facebook-group-post");
      assert.ok(demoRaw, "Setting videoDemo:facebook-group-post phải được lưu");
      const demo = JSON.parse(demoRaw) as VideoDemoAttachment;
      assert.equal(demo.scriptId, "facebook-group-post");
      assert.equal(demo.scriptVersion, "1.0.0");
      assert.equal(demo.artifactRef, "demos/facebook-group-post/run-1/recording.webm");
      assert.equal(demo.thumbnailRef, "demos/facebook-group-post/run-1/recording-thumb.jpg");
      assert.equal(demo.sha256, mockVideoShaV1);
      assert.equal(demo.reviewed, true);
    });

    // -------------------------------------------------------------------------
    // TEST B: Mở Script vừa sync -> phát được video
    // -------------------------------------------------------------------------
    await t.test("TEST B: Mở Script vừa sync -> Đọc và phát được Video Demo & Thumbnail từ local", () => {
      const demoRaw = store.setting("videoDemo:facebook-group-post");
      assert.ok(demoRaw);
      const demo = JSON.parse(demoRaw) as VideoDemoAttachment;

      // Simulate playback via scenarioDemoMedia IPC handler logic
      const videoAbs = path.resolve(testRunsDir, demo.artifactRef);
      assert.ok(videoAbs.startsWith(path.resolve(testRunsDir)));
      assert.ok(fs.existsSync(videoAbs));

      const videoData = fs.readFileSync(videoAbs);
      const videoDataUrl = `data:video/webm;base64,${videoData.toString("base64")}`;
      assert.equal(videoDataUrl, `data:video/webm;base64,${mockVideoBufferV1.toString("base64")}`);

      const thumbAbs = path.resolve(testRunsDir, demo.thumbnailRef!);
      assert.ok(fs.existsSync(thumbAbs));
      const thumbData = fs.readFileSync(thumbAbs);
      const thumbDataUrl = `data:image/jpeg;base64,${thumbData.toString("base64")}`;
      assert.equal(thumbDataUrl, `data:image/jpeg;base64,${mockThumbBufferV1.toString("base64")}`);
    });

    // -------------------------------------------------------------------------
    // TEST C: Sync lần hai -> không download trùng (Idempotency)
    // -------------------------------------------------------------------------
    await t.test("TEST C: Sync lần hai -> Idempotent, không download lại video đã có", async () => {
      const vidDownloadsBefore = videoDemoDownloads;
      const thumbDownloadsBefore = thumbnailDownloads;

      const res2 = await service.syncActionTags();
      assert.equal(res2.ok, true);

      // Verify no additional network requests for media
      assert.equal(videoDemoDownloads, vidDownloadsBefore, "Không được tải lại video đã có");
      assert.equal(thumbnailDownloads, thumbDownloadsBefore, "Không được tải lại thumbnail đã có");

      const flows = store.flows();
      assert.equal(flows.length, 1);
      const steps = store.steps();
      assert.equal(steps.length, 1);
    });

    // -------------------------------------------------------------------------
    // TEST D: Release mới -> nhận đúng video mới, giữ video cũ
    // -------------------------------------------------------------------------
    await t.test("TEST D: Release mới trên SEO-OPS -> Nhận đúng video mới, giữ nguyên video cũ", async () => {
      currentVideoBuffer = mockVideoBufferV2;
      currentVideoSha = mockVideoShaV2;
      currentThumbBuffer = mockThumbBufferV2;
      currentThumbSha = mockThumbShaV2;

      const activeScriptV2 = {
        ...activeScriptV1,
        version: "2.0.0",
        content_digest: "2222222222222222222222222222222222222222222222222222222222222222",
        execution_digest: "e222222222222222222222222222222222222222222222222222222222222222",
        name: "Facebook Group Post Standard v2",
        release: {
          ...activeScriptV1.release,
          version: "2.0.0",
          name: "Facebook Group Post Standard v2",
          content_digest: "2222222222222222222222222222222222222222222222222222222222222222",
          execution_digest: "e222222222222222222222222222222222222222222222222222222222222222",
          manifest: {
            ...activeScriptV1.release.manifest,
            video_demo: {
              artifact_ref: "demos/facebook-group-post/run-2/recording.webm",
              sha256: mockVideoShaV2,
              mime: "video/webm",
              test_run_id: "run-2",
              reviewed: true,
              thumbnail_ref: "demos/facebook-group-post/run-2/recording-thumb.jpg",
              thumbnail_sha256: mockThumbShaV2,
            },
          },
        },
      };

      mockActiveScripts = [activeScriptV2];

      const resUpdate = await service.syncActionTags();
      assert.equal(resUpdate.ok, true);

      // New video downloaded to run-2
      const newVideoPath = path.join(testRunsDir, "demos", "facebook-group-post", "run-2", "recording.webm");
      assert.ok(fs.existsSync(newVideoPath), "Video v2 mới phải được tải");
      assert.deepEqual(fs.readFileSync(newVideoPath), mockVideoBufferV2);

      // Old video from run-1 is STILL preserved (not deleted)
      const oldVideoPath = path.join(testRunsDir, "demos", "facebook-group-post", "run-1", "recording.webm");
      assert.ok(fs.existsSync(oldVideoPath), "Video v1 cũ không được bị xóa");
      assert.deepEqual(fs.readFileSync(oldVideoPath), mockVideoBufferV1);

      // Setting updated to v2
      const demoRaw = store.setting("videoDemo:facebook-group-post");
      const demo = JSON.parse(demoRaw!) as VideoDemoAttachment;
      assert.equal(demo.scriptVersion, "2.0.0");
      assert.equal(demo.testRunId, "run-2");
      assert.equal(demo.sha256, mockVideoShaV2);
    });

    // -------------------------------------------------------------------------
    // TEST E: Video không tồn tại trên server (404) -> Báo lỗi rõ
    // -------------------------------------------------------------------------
    await t.test("TEST E: Video không tồn tại trên server (404) -> Báo lỗi cụ thể, không fake sync", async () => {
      // Simulate remote script release v3 with missing video on server
      videoDemo404 = true;
      const activeScriptV3 = {
        ...activeScriptV1,
        version: "3.0.0",
        content_digest: "3333333333333333333333333333333333333333333333333333333333333333",
        name: "Facebook Group Post Missing Video",
        release: {
          ...activeScriptV1.release,
          version: "3.0.0",
          content_digest: "3333333333333333333333333333333333333333333333333333333333333333",
          manifest: {
            ...activeScriptV1.release.manifest,
            video_demo: {
              artifact_ref: "demos/facebook-group-post/run-3/recording.webm",
              sha256: "3333333333333333333333333333333333333333333333333333333333333333",
              mime: "video/webm",
              test_run_id: "run-3",
              reviewed: true,
              thumbnail_ref: "demos/facebook-group-post/run-3/recording-thumb.jpg",
              thumbnail_sha256: "3333333333333333333333333333333333333333333333333333333333333333",
            },
          },
        },
      };
      mockActiveScripts = [activeScriptV3];

      const failRes = await service.syncActionTags();
      assert.equal(failRes.ok, false);
      if (!failRes.ok) {
        assert.match(failRes.error, /Đồng bộ Demo Video cho Active Script/i);
        assert.match(failRes.error, /facebook-group-post/i);
      }

      // Local flow must remain at v2, NOT upgraded to incomplete v3
      const flow = store.flows().find(f => f.id === "facebook-group-post");
      assert.equal(flow?.name, "Facebook Group Post Standard v2");

      videoDemo404 = false;
    });

    // -------------------------------------------------------------------------
    // TEST F: Download bị ngắt giữa chừng / checksum mismatch -> không tạo file giả
    // -------------------------------------------------------------------------
    await t.test("TEST F: Download bị lỗi hoặc checksum mismatch -> Không để lại file hỏng/giả", async () => {
      videoDemoCorrupt = true;
      const targetV3Path = path.join(testRunsDir, "demos", "facebook-group-post", "run-corrupt", "recording.webm");

      const activeScriptCorrupt = {
        ...activeScriptV1,
        version: "3.5.0",
        content_digest: "3535353535353535353535353535353535353535353535353535353535353535",
        release: {
          ...activeScriptV1.release,
          version: "3.5.0",
          content_digest: "3535353535353535353535353535353535353535353535353535353535353535",
          manifest: {
            ...activeScriptV1.release.manifest,
            video_demo: {
              artifact_ref: "demos/facebook-group-post/run-corrupt/recording.webm",
              sha256: mockVideoShaV1,
              mime: "video/webm",
              test_run_id: "run-corrupt",
              reviewed: true,
              thumbnail_ref: "demos/facebook-group-post/run-corrupt/recording-thumb.jpg",
              thumbnail_sha256: mockThumbShaV1,
            },
          },
        },
      };
      mockActiveScripts = [activeScriptCorrupt];

      const failRes = await service.syncActionTags();
      assert.equal(failRes.ok, false);
      if (!failRes.ok) {
        assert.match(failRes.error, /Checksum mismatch/i);
      }

      // Target file must NOT exist (atomic cleanup unlinked temporary file)
      assert.equal(fs.existsSync(targetV3Path), false, "Không được để lại file video hỏng");

      videoDemoCorrupt = false;
    });

    // -------------------------------------------------------------------------
    // TEST G: Video của Script History local không bị xóa
    // -------------------------------------------------------------------------
    await t.test("TEST G: Video của Script History local không bị xóa qua các lần sync", () => {
      const v1Video = path.join(testRunsDir, "demos", "facebook-group-post", "run-1", "recording.webm");
      const v2Video = path.join(testRunsDir, "demos", "facebook-group-post", "run-2", "recording.webm");
      assert.ok(fs.existsSync(v1Video), "Video v1 vẫn còn nguyên trên đĩa");
      assert.ok(fs.existsSync(v2Video), "Video v2 vẫn còn nguyên trên đĩa");
    });

    // -------------------------------------------------------------------------
    // TEST H: Regression: Action Tags, Steps, ROI assets vẫn PASS
    // -------------------------------------------------------------------------
    await t.test("TEST H: Regression: Đồng bộ Action Tags hiện tại vẫn PASS khi tag không có script", async () => {
      mockTags = [
        sampleTag,
        sampleTagNoScript,
        {
          id: 103,
          tag_key: "reddit.community.post",
          platform: "reddit",
          target: "community",
          action: "post",
          name: "Reddit Community Post",
        },
      ];
      mockActiveScripts = [];

      const res = await service.syncActionTags();
      assert.equal(res.ok, true);
      if (!res.ok) return;

      assert.equal(res.count, 3);
      assert.equal(store.actionTags().length, 3);
      assert.equal(store.actionTag("reddit.community.post")?.name, "Reddit Community Post");
    });
  } finally {
    server.close();
    store.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
