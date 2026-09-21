import assert from "node:assert/strict";
import test from "node:test";
import { transcodeToM4a } from "../transcoder";

test("rejects an MP4 fragment without an initialization segment", async () => {
  // A moof-only fragment has no ftyp/init segment and cannot be repaired by
  // FFmpeg; it must never become a published voice object.
  const moofOnly = Buffer.alloc(32);
  moofOnly.writeUInt32BE(8, 0);
  moofOnly.write("moof", 4, "ascii");
  await assert.rejects(
    () => transcodeToM4a(moofOnly, "audio/mp4"),
    /Unsupported or invalid audio container/,
  );
});