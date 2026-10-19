export interface ClipboardPort<T> {
  read(): Promise<T>;
  write(value: T): Promise<void>;
  writeText(text: string): Promise<void>;
  fingerprint(value: T): Promise<string>;
}
// Snapshot before touching the clipboard; do not overwrite a concurrent user copy.
export async function pasteWithClipboard<T>(
  port: ClipboardPort<T>,
  text: string,
  paste: () => void,
  ready: () => void,
  wait = () => new Promise<void>((r) => setTimeout(r, 500)),
) {
  const previous = await port.read();
  ready();
  let own: string | undefined;
  let clipboard: "restored" | "changed" | "restore_failed" = "restore_failed";
  let warning: string | undefined;
  try {
    await port.writeText(text);
    own = await port.fingerprint(await port.read());
    ready();
    paste();
    await wait(); // Native paste is asynchronous; not proof that a website accepted text.
  } finally {
    try {
      if (!own) {
        warning =
          "Không xác định được clipboard tạm sau khi ghi; không ghi đè clipboard hiện tại.";
      } else if ((await port.fingerprint(await port.read())) !== own) {
        clipboard = "changed";
        warning =
          "Clipboard đã đổi trong lúc paste; giữ nội dung mới, không ghi đè.";
      } else {
        await port.write(previous);
        clipboard = "restored";
      }
    } catch {
      warning =
        "Không phục hồi được clipboard. Nội dung paste có thể vẫn ở clipboard.";
    }
  }
  return { clipboard, warning };
}
