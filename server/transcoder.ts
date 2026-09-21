import { spawn } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import ffmpegStatic from "ffmpeg-static";

const FFMPEG_BIN: string = (ffmpegStatic as string | null) ?? "ffmpeg";

// ── Magic-byte container detection ────────────────────────────────────────────
// Detects actual audio container from file bytes — more reliable than MIME type
// because multer may report application/octet-stream or the client can lie.
type AudioFormat = "mp4" | "webm" | "ogg" | "unknown";

function detectFormat(buf: Buffer): AudioFormat {
  if (buf.length < 12) return "unknown";
  // MP4 / M4A / MPEG-4: bytes 4-7 = "ftyp"
  if (buf.slice(4, 8).toString("binary") === "ftyp") return "mp4";
  // WebM / Matroska: EBML header starts with 0x1A 0x45 0xDF 0xA3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
  // OGG: starts with "OggS"
  if (buf.slice(0, 4).toString("binary") === "OggS") return "ogg";
  return "unknown";
}

/**
 * Transcodes any browser-recorded audio to AAC inside an MP4 container.
 *
 * Format detection uses magic bytes — not just the declared MIME type.
 *
 * Every accepted format is decoded and re-encoded. This is intentional: in
 * particular, fragmented MP4 from iOS must not be published as-is.
 */
export async function transcodeToM4a(
  inputBuffer: Buffer,
  inputMime: string
): Promise<Buffer> {
  const actualFormat = detectFormat(inputBuffer);
  if (actualFormat === "unknown") {
    throw new Error("Unsupported or invalid audio container");
  }
  console.log(`[VOICE_NOTE] transcode start format=${actualFormat} bytes=${inputBuffer.length}`);

  const inputExt =
    actualFormat === "ogg" ? ".ogg"
    : actualFormat === "webm" ? ".webm"
    : ".mp4";

  const id = randomBytes(8).toString("hex");
  const inputPath = join(tmpdir(), `vn_${id}_in${inputExt}`);
  const outputPath = join(tmpdir(), `vn_${id}_out.m4a`);

  await writeFile(inputPath, inputBuffer);

  const args = [
    "-hide_banner",
    ...(actualFormat === "mp4" ? ["-fflags", "+genpts+igndts"] : []),
    "-i", inputPath,
    "-c:a", "aac",
    "-b:a", "32k",
    "-ac", "1",
    "-ar", "16000",
    "-vn",
    "-movflags", "+faststart",
    "-y",
    outputPath,
  ];

  try {
    await runFfmpeg(args, 30_000);
    const output = await readFile(outputPath);
    if (output.length === 0) throw new Error("FFmpeg produced empty audio");
    console.log(`[VOICE_NOTE] transcode complete bytes=${output.length}`);
    return output;
  } catch (err: any) {
    console.error(`[VOICE_NOTE_PIPELINE] FFmpeg failed: ${err.message}`);
    throw err;
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

interface FfmpegResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`FFmpeg timed out after ${timeoutMs / 1000}s\nstderr: ${stderr.slice(-400)}`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`FFmpeg exited ${code}\nstderr: ${stderr.slice(-800)}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}
