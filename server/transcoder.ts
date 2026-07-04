import { spawn } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import ffmpegStatic from "ffmpeg-static";
const FFMPEG_BIN: string = (ffmpegStatic as string | null) ?? "ffmpeg";

/**
 * Transcodes any browser-recorded audio to AAC inside an MP4 container (.m4a).
 *
 * Fast path (iOS Safari / audio/mp4):
 *   The browser already records native AAC in fragmented MP4. We remux without
 *   re-encoding (-c:a copy) and just move the moov atom to the front for
 *   instant browser playback. This takes ~50 ms regardless of clip length.
 *
 * Standard path (Chrome/Android WebM, Firefox OGG):
 *   Re-encode to AAC at 32 kbps / 16 kHz mono. 16 kHz mono is more than
 *   sufficient for voice notes and cuts file size roughly in half compared
 *   to the previous 64 kbps / 44.1 kHz settings.
 *
 * Typical output sizes after optimisation:
 *   10-second clip  → iOS ~40 KB (copy) / Chrome ~40 KB (32 k)
 *   30-second clip  → iOS ~120 KB (copy) / Chrome ~120 KB (32 k)
 *   60-second clip  → iOS ~240 KB (copy) / Chrome ~240 KB (32 k)
 */
export async function transcodeToM4a(
  inputBuffer: Buffer,
  inputMime: string
): Promise<Buffer> {
  const isMp4Input =
    inputMime.includes("mp4") || inputMime.includes("m4a") || inputMime.includes("aac");
  const inputExt = isMp4Input ? ".mp4" : inputMime.includes("ogg") ? ".ogg" : ".webm";

  const id = randomBytes(8).toString("hex");
  const inputPath = join(tmpdir(), `vn_${id}_in${inputExt}`);
  const outputPath = join(tmpdir(), `vn_${id}_out.m4a`);

  await writeFile(inputPath, inputBuffer);

  // Safari/iOS produces fragmented MP4 — need these flags for correct decoding.
  const inputFlags: string[] = isMp4Input ? ["-fflags", "+genpts+igndts"] : [];

  const encodeArgs: string[] = isMp4Input
    // Fast path: just remux, no re-encode (~50 ms)
    ? ["-c:a", "copy", "-movflags", "+faststart"]
    // Standard path: re-encode at 32 kbps / 16 kHz mono
    : ["-c:a", "aac", "-b:a", "32k", "-ac", "1", "-ar", "16000", "-movflags", "+faststart"];

  try {
    await runFfmpeg(
      [
        ...inputFlags,
        "-i", inputPath,
        ...encodeArgs,
        "-y",
        outputPath,
      ],
      30_000
    );
    return await readFile(outputPath);
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`FFmpeg timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-600)}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}
