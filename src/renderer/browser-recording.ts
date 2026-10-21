/** A detached canvas receives only Browser CDP frames, never desktop or audio. */
export function installBrowserRecording() {
  let current: { token: string; recorder: MediaRecorder; stream: MediaStream; canvas: HTMLCanvasElement;
    queue: Promise<void>; frames: Promise<void>; initialized: boolean } | undefined;
  const send = (token: string, event: "ready" | "chunk" | "done" | "error", data?: string) =>
    window.creator.invoke({ type: "recordingEvent", token, event, data });
  return window.creator.onRecording(message => {
    if (message.type === "start") {
      try {
        const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
        const stream = canvas.captureStream(15);
        const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(x => MediaRecorder.isTypeSupported(x));
        if (!mimeType) throw new Error("WebM encoder unavailable");
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1500000 });
        const run = current = { token: message.token, recorder, stream, canvas, queue: Promise.resolve(), frames: Promise.resolve(), initialized: false };
        recorder.ondataavailable = event => {
          if (!event.data.size) return;
          run.queue = run.queue.then(async () => {
            const bytes = new Uint8Array(await event.data.arrayBuffer());
            // Bound IPC chunks independently of encoder chunk size.
            for (let i = 0; i < bytes.length; i += 1024 * 1024) {
              let value = ""; for (const b of bytes.subarray(i, i + 1024 * 1024)) value += String.fromCharCode(b);
              await send(run.token, "chunk", btoa(value));
            }
          }).catch(() => { void send(run.token, "error").catch(() => {}); });
        };
        recorder.onstop = () => { void run.queue.then(() => send(run.token, "done")).catch(() => {}); stream.getTracks().forEach(t => t.stop()); };
        recorder.onerror = () => { void send(run.token, "error").catch(() => {}); };
        recorder.start(1000); void send(run.token, "ready").catch(() => {});
      } catch { void send(message.token, "error").catch(() => {}); }
    } else if (current?.token === message.token) {
      const run = current;
      if (message.type === "frame" && message.data) run.frames = run.frames.then(async () => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${message.data}`)).blob());
        const context = run.canvas.getContext("2d")!;
        context.fillStyle = "#000"; context.fillRect(0, 0, run.canvas.width, run.canvas.height);
        const scale = Math.min(run.canvas.width / bitmap.width, run.canvas.height / bitmap.height);
        context.drawImage(bitmap, 0, 0, bitmap.width * scale, bitmap.height * scale); bitmap.close();
      }).catch(() => { void send(run.token, "error").catch(() => {}); });
      else if (message.type === "stop") {
        current = undefined;
        void run.frames.finally(() => { if (run.recorder.state !== "inactive") run.recorder.stop(); });
      }
    }
  });
}
