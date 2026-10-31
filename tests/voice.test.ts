import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { silkToWav, toSilk, VOICE_SAMPLE_RATE } from "../server/channels/voice";

// voice.ts extracts silk-wasm under $PASEO_HOME/plugin-data on first use.
beforeAll(() => {
  process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "paseo-voice-test-"));
});

/** A short mono s16le WAV of a sine wave. */
function sineWav(sampleRate: number, samples: number): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 8_000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe("voice codec", () => {
  it("round-trips WAV through SILK and back to a playable WAV", async () => {
    const wav = sineWav(VOICE_SAMPLE_RATE, VOICE_SAMPLE_RATE / 10);
    const { silk, playtimeMs } = await toSilk("/tmp/in.wav", wav);
    expect(playtimeMs).toBeGreaterThan(0);
    // Tencent's wire format: a 0x02 byte, then the SILK header.
    expect(silk[0]).toBe(0x02);
    expect(silk.toString("ascii", 1, 10)).toBe("#!SILK_V3");

    const back = await silkToWav(silk, VOICE_SAMPLE_RATE);
    expect(back.toString("ascii", 0, 4)).toBe("RIFF");
    expect(back.readUInt32LE(24)).toBe(VOICE_SAMPLE_RATE);
    expect(back.readUInt16LE(22)).toBe(1); // mono
    expect(back.length).toBeGreaterThan(44);
  });

  it("refuses bytes that aren't SILK", async () => {
    await expect(silkToWav(Buffer.from("plain mp3 bytes, really"), 8_000)).rejects.toThrow("not SILK audio");
  });
});
