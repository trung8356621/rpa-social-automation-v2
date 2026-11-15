import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "src", "renderer", "public", "sounds");
mkdirSync(out, { recursive: true });

function wav(name, frequencies) {
  const rate = 22050, duration = 0.42, samples = Math.floor(rate * duration), dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataSize, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate, slot = Math.min(frequencies.length - 1, Math.floor(t / (duration / frequencies.length)));
    const envelope = Math.sin(Math.PI * Math.min(1, (t % (duration / frequencies.length)) / (duration / frequencies.length)));
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequencies[slot] * t) * envelope * 5000), 44 + i * 2);
  }
  writeFileSync(resolve(out, name), buffer);
}

wav("completion-success.wav", [523.25, 659.25]);
wav("completion-attention.wav", [392, 311.13]);
