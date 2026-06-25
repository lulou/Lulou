import { spawn } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
// ffmpeg-static ships a pre-compiled static binary that works in any Node.js
// deployment environment (including Replit deployments that don't have system
// FFmpeg in PATH). Fall back to "ffmpeg" if the package isn't available.
import ffmpegStatic from "ffmpeg-static";
const FFMPEG_BIN: string = (ffmpegStatic as string | null) ?? "ffmpeg";

/**
 * Transcodes any browser-recorded audio (WebM/Opus, OGG/Opus, MP4/AAC, etc.)
 * to AAC inside an MP4 container (.m4a) — the single universal playback format
 * supported by every target browser and platform:
 *
 *   Chrome / Android ✅   Firefox ✅   Safari / iOS ✅   Edge ✅
 *
 * Encoding settings chosen for voice notes:
 *   -c:a aac          built-in FFmpeg encoder (no libfdk_aac needed)
 *   -b:a 64k          64 kbps — excellent quality for speech
 *   -ac 1             mono (voice doesn't need stereo; halves file size)
 *   -ar 44100         44.1 kHz sample rate
 *   -movflags +faststart  moves the MP4 moov atom to the front so the
 *                         browser can start playback before the full file
 *                         is downloaded
 *
 * Typical output sizes:
 *   10-second clip  →  ~80 KB
 *   30-second clip  →  ~240 KB
 *   60-second clip  →  ~480 KB
 */
export async function transcodeToM4a(
  inputBuffer: Buffer,
  inputMime: string
): Promise<Buffer> {
  // Give the temp input file the right extension so FFmpeg probes the
  // container format correctly regardless of MIME string.
  const inputExt =
    inputMime.includes("ogg") ? ".ogg"
    : inputMime.includes("mp4") || inputMime.includes("m4a") || inputMime.includes("aac") ? ".mp4"
    : ".webm";

  const id = randomBytes(8).toString("hex");
  const inputPath = join(tmpdir(), `vn_${id}_in${inputExt}`);
  const outputPath = join(tmpdir(), `vn_${id}_out.m4a`);

  await writeFile(inputPath, inputBuffer);

  // Safari/iOS MediaRecorder produces fragmented MP4 (ISOBMFF). Without these
  // flags FFmpeg may fail to decode the initialization segment correctly.
  const inputFlags: string[] = inputExt === ".mp4"
    ? ["-fflags", "+genpts+igndts"]
    : [];

  try {
    await runFfmpeg(
      [
        ...inputFlags,
        "-i", inputPath,
        "-c:a", "aac",
        "-b:a", "64k",
        "-ac", "1",
        "-ar", "44100",
        "-movflags", "+faststart",
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
