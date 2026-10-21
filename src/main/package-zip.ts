/** Bounded ZIP32 STORE transport. No shell, external archiver or dependency required. */
const MAX_BYTES = 384 * 1024 * 1024, MAX_FILES = 3000;
export function safePackagePath(name: string) {
  if (typeof name !== "string" || name.length > 240 || !/^[A-Za-z0-9_.\/-]+$/.test(name) || name.startsWith("/")
    || name.split("/").some(p => !p || p === "." || p === ".." || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) || p.endsWith("."))) throw new Error("ZIP_PATH: Unsafe package entry.");
}
export function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function encodeZip(files: Record<string, Buffer>): Buffer {
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (!entries.length || entries.length > MAX_FILES || entries.reduce((n, [, b]) => n + b.length, 0) > MAX_BYTES) throw new Error("ZIP_LIMIT");
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0, centralSize = 0;
  for (const [name, bytes] of entries) {
    safePackagePath(name); const filename = Buffer.from(name), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12); // Deterministic valid DOS date: 1980-01-01.
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(33, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); offset += header.length + filename.length + bytes.length; centralSize += directory.length + filename.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
export function decodeZip(zip: Buffer): Record<string, Buffer> {
  if (zip.length < 22 || zip.length > MAX_BYTES + 2 * 1024 * 1024) throw new Error("ZIP_LIMIT");
  const end = zip.length - 22;
  if (zip.readUInt32LE(end) !== 0x06054b50 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 20)) throw new Error("ZIP_FORMAT: Expected single-disk ZIP without comments.");
  const count = zip.readUInt16LE(end + 10), centralSize = zip.readUInt32LE(end + 12), start = zip.readUInt32LE(end + 16);
  if (!count || count > MAX_FILES || zip.readUInt16LE(end + 8) !== count || start + centralSize !== end) throw new Error("ZIP_DIRECTORY");
  let position = start, localEnd = 0, total = 0;
  const files: Record<string, Buffer> = Object.create(null), folded = new Set<string>();
  const ensure = (offset: number, size: number, limit = zip.length) => { if (offset < 0 || size < 0 || offset + size > limit) throw new Error("ZIP_TRUNCATED"); };
  for (let i = 0; i < count; i++) {
    ensure(position, 46, end);
    if (zip.readUInt32LE(position) !== 0x02014b50 || zip.readUInt16LE(position + 8) || zip.readUInt16LE(position + 10)) throw new Error("ZIP_METHOD: Only unencrypted STORE is supported.");
    const crc = zip.readUInt32LE(position + 16), size = zip.readUInt32LE(position + 20), uncompressed = zip.readUInt32LE(position + 24);
    const length = zip.readUInt16LE(position + 28), extra = zip.readUInt16LE(position + 30), comment = zip.readUInt16LE(position + 32), offset = zip.readUInt32LE(position + 42);
    if (extra || comment || zip.readUInt16LE(position + 34) || zip.readUInt32LE(position + 38) || size !== uncompressed || offset !== localEnd) throw new Error("ZIP_ENTRY: Unexpected attributes, extension, size or offset.");
    ensure(position + 46, length, end); const name = zip.subarray(position + 46, position + 46 + length).toString("utf8");
    safePackagePath(name); if (folded.has(name.toLowerCase())) throw new Error("ZIP_DUPLICATE"); folded.add(name.toLowerCase());
    ensure(offset, 30, start);
    if (zip.readUInt32LE(offset) !== 0x04034b50 || zip.readUInt16LE(offset + 6) || zip.readUInt16LE(offset + 8)
      || zip.readUInt32LE(offset + 14) !== crc || zip.readUInt32LE(offset + 18) !== size || zip.readUInt32LE(offset + 22) !== size
      || zip.readUInt16LE(offset + 26) !== length || zip.readUInt16LE(offset + 28)) throw new Error("ZIP_LOCAL_HEADER");
    ensure(offset + 30, length + size, start);
    if (zip.subarray(offset + 30, offset + 30 + length).toString("utf8") !== name) throw new Error("ZIP_NAME_MISMATCH");
    const bytes = zip.subarray(offset + 30 + length, offset + 30 + length + size); total += size;
    if (total > MAX_BYTES || crc32(bytes) !== crc) throw new Error("ZIP_INTEGRITY");
    files[name] = bytes; localEnd = offset + 30 + length + size; position += 46 + length;
  }
  if (position !== end || localEnd !== start) throw new Error("ZIP_UNDECLARED_BYTES");
  return files;
}
