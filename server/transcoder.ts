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

// ── FFprobe-style probe using FFmpeg -i (ffprobe not bundled) ─────────────────
async function probeWithFfmpeg(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    // ffmpeg -i file (no output) always exits non-zero but prints stream info to stderr
    const proc = spawn(FFMPEG_BIN, ["-hide_banner", "-i", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    proc.stderr?.on("data", (c: Buffer) => { out += c.toString(); });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve("(probe timeout)"); }, 5_000);
    proc.on("close", () => { clearTimeout(timer); resolve(out); });
    proc.on("error", (e) => { clearTimeout(timer); resolve(`(probe error: ${e.message})`); });
  });
}

/**
 * Transcodes any browser-recorded audio to AAC inside an MP4 container.
 *
 * Format detection uses magic bytes — not just the declared MIME type.
 *
 * iOS Safari fast path (audio already MP4/AAC):
 *   Returns the original buffer WITHOUT running FFmpeg.
 *   Safari records fragmented MP4. FFmpeg -c:a copy can fail on fragmented
 *   MP4 because there is no standalone moov atom before the media data.
 *   The raw fragmented MP4 plays natively in Safari/iOS and modern browsers.
 *
 * Chrome/Android (WebM) and Firefox (OGG):
 *   Re-encode to AAC at 32 kbps / 16 kHz mono via FFmpeg.
 *   Logs exact command, stdout, stderr, and exit code.
 */
export async function transcodeToM4a(
  inputBuffer: Buffer,
  inputMime: string
): Promise<Buffer> {
  const magicHex = inputBuffer.slice(0, 16).toString("hex").toUpperCase().replace(/.{2}/g, "$& ").trim();
  const actualFormat = detectFormat(inputBuffer);

  console.log(`[VOICE_NOTE_PIPELINE] original filename=voice.${actualFormat === "mp4" ? "m4a" : actualFormat === "ogg" ? "ogg" : "webm"}`);
  console.log(`[VOICE_NOTE_PIPELINE] MIME type (declared)=${inputMime}`);
  console.log(`[VOICE_NOTE_PIPELINE] detected format (magic bytes)=${actualFormat}`);
  console.log(`[VOICE_NOTE_PIPELINE] magic bytes (first 16)=${magicHex}`);
  console.log(`[VOICE_NOTE_PIPELINE] input size=${inputBuffer.length}B`);
  console.log(`[VOICE_NOTE_PIPELINE] FFmpeg binary=${FFMPEG_BIN}`);

  // ── iOS / MP4 fast path: no FFmpeg needed ────────────────────────────────
  // iOS Safari records native AAC in a fragmented MP4 container. Running
  // `ffmpeg -c:a copy` on fragmented MP4 fails when the moov atom is not
  // present before the mdat atoms (common in live-recording mode).
  // The original buffer plays natively — skip transcoding entirely.
  const isMp4 =
    actualFormat === "mp4" ||
    (actualFormat === "unknown" &&
      (inputMime.includes("mp4") || inputMime.includes("m4a") || inputMime.includes("aac")));

  if (isMp4) {
    console.log(`[VOICE_NOTE_PIPELINE] transcode skipped — already MP4/AAC (no FFmpeg needed)`);
    console.log(`[VOICE_NOTE_SPEED] transcode=skipped format=MP4 size=${inputBuffer.length}B`);
    return inputBuffer;
  }

  // ── WebM / OGG: transcode via FFmpeg ─────────────────────────────────────
  const inputExt =
    actualFormat === "ogg" ? ".ogg"
    : actualFormat === "webm" ? ".webm"
    : inputMime.includes("ogg") ? ".ogg"
    : ".webm";

  const id = randomBytes(8).toString("hex");
  const inputPath = join(tmpdir(), `vn_${id}_in${inputExt}`);
  const outputPath = join(tmpdir(), `vn_${id}_out.m4a`);

  await writeFile(inputPath, inputBuffer);

  // Probe before transcoding
  const probeOut = await probeWithFfmpeg(inputPath);
  console.log(`[VOICE_NOTE_PIPELINE] ffprobe output:\n${probeOut}`);

  const args = [
    "-hide_banner",
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

  console.log(`[VOICE_NOTE_PIPELINE] FFmpeg command=${FFMPEG_BIN} ${args.join(" ")}`);

  try {
    const { stdout, stderr, code } = await runFfmpeg(args, 30_000);
    console.log(`[VOICE_NOTE_PIPELINE] FFmpeg exit code=${code}`);
    if (stdout) console.log(`[VOICE_NOTE_PIPELINE] FFmpeg stdout=${stdout}`);
    console.log(`[VOICE_NOTE_PIPELINE] FFmpeg stderr=${stderr}`);

    const output = await readFile(outputPath);
    console.log(`[VOICE_NOTE_PIPELINE] transcode complete outputSize=${output.length}B`);
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
