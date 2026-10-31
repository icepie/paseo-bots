import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type * as SilkWasm from "silk-wasm";

import { pluginDataPath } from "../bot-home";
import { SILK_CJS, SILK_VERSION, SILK_WASM_BASE64 } from "./vendor/silk-package";

// WeChat voice messages are SILK. silk-wasm (a wasm build of Tencent's codec)
// encodes and decodes in-process; arbitrary audio formats go through ffmpeg
// first. The sample rate matches what sendMedia puts on the wire.

export const VOICE_SAMPLE_RATE = 24_000;

const execFileAsync = promisify(execFile);

export interface SilkVoice {
  silk: Buffer;
  /** Voice duration, for voice_item.playtime. */
  playtimeMs: number;
}

/**
 * silk-wasm's entry point locates its .wasm file relative to __filename, but
 * Paseo evaluates the plugin bundle without it — so the package ships inside
 * the bundle (see vendor/silk-package.ts) and is written to the plugin data
 * directory on first use, where a real require() can load it.
 */
let silk: Promise<typeof SilkWasm> | null = null;

function loadSilk(): Promise<typeof SilkWasm> {
  silk ??= (async () => {
    const dir = join(pluginDataPath(), "silk-wasm", SILK_VERSION);
    await mkdir(dir, { recursive: true });
    const entry = join(dir, "index.cjs");
    await writeFile(entry, SILK_CJS);
    await writeFile(join(dir, "silk.wasm"), Buffer.from(SILK_WASM_BASE64, "base64"));
    return createRequire(entry)(entry) as typeof SilkWasm;
  })();
  return silk;
}

/**
 * An audio file (any format ffmpeg reads, or already-SILK) as WeChat voice.
 * Throws when ffmpeg is missing or the file can't be decoded.
 */
export async function toSilk(path: string, raw: Buffer): Promise<SilkVoice> {
  const { encode } = await loadSilk();
  const wav = await toWav(path, raw);
  const encoded = await encode(new Uint8Array(wav), 0);
  return { silk: Buffer.from(encoded.data), playtimeMs: Math.round(encoded.duration) };
}

/** SILK bytes as a WAV file the bot's tools can play. */
export async function silkToWav(silkBytes: Buffer, sampleRate: number | null): Promise<Buffer> {
  const { decode } = await loadSilk();
  // Tencent wraps SILK with a 0x02 byte before the "#!SILK_V3" header, and
  // silk-wasm's decoder expects the wrapper on, so restore it when missing.
  let body = silkBytes;
  if (body[0] === 0x02) {
    if (body.toString("ascii", 1, 10) !== "#!SILK_V3") throw new Error("not SILK audio");
  } else {
    if (body.toString("ascii", 0, 9) !== "#!SILK_V3") throw new Error("not SILK audio");
    body = Buffer.concat([Buffer.from([0x02]), body]);
  }
  const rate = sampleRate ?? VOICE_SAMPLE_RATE;
  const pcm = await decode(new Uint8Array(body), rate);
  return wavWrap(Buffer.from(pcm.data), rate);
}

/** Any audio → 24 kHz mono WAV (what silk-wasm's encoder eats). */
async function toWav(path: string, raw: Buffer): Promise<Buffer> {
  const { isWav } = await loadSilk();
  if (isWav(new Uint8Array(raw))) return raw;
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", String(VOICE_SAMPLE_RATE), "-f", "wav", "pipe:1"], { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
    return stdout;
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : error instanceof Error ? error.message : String(error);
    throw new Error(`ffmpeg couldn't convert the audio to WAV (${detail || "is ffmpeg installed?"})`);
  }
}

/** A 44-byte PCM header around mono s16le samples. */
function wavWrap(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // bytes/sec
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
