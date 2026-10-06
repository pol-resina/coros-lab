#!/usr/bin/env tsx
/**
 * Download the audio of a YouTube video as MP3 onto a COROS Pace 3.
 *
 * Tracks are staged in a local temp dir first and only copied to the watch once
 * the transcode finished cleanly — a cancelled or failed download never leaves a
 * half-written file on the watch's FAT32 volume.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const YTDLP = path.join(ROOT, "bin", "yt-dlp");

/** COROS stores music under Music/<playlist>/. "Default" is the built-in one. */
const DEFAULT_DEST = "/media/pol/PACE 3/Music/Default";

/** Leave this much room on the watch so we never fill the volume completely. */
const FREE_SPACE_MARGIN = 50 * 1024 * 1024;

interface VideoInfo {
  id: string;
  title: string;
  uploader?: string;
  duration?: number;
}

// ---------------------------------------------------------------- utilities

function log(msg: string): void {
  console.log(msg);
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds) return "?:??";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Make a title safe for the watch's FAT32 volume.
 *
 * FAT32 rejects \ / : * ? " < > | and control characters, and chokes on names
 * that end in a dot or space. Accents and emoji are fine — the volume is
 * mounted utf8, and the existing library already contains both.
 */
function sanitizeForFat32(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .trim()
    .replace(/[. ]+$/, "");
  // FAT32 allows 255 chars, but long names bloat the directory table and some
  // COROS firmware truncates them on screen. 120 is comfortable.
  const trimmed = cleaned.slice(0, 120).replace(/[. ]+$/, "");
  return trimmed.length > 0 ? trimmed : "track";
}

// ------------------------------------------------------------------ yt-dlp

function run(
  cmd: string,
  args: string[],
  opts: { capture?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: opts.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${path.basename(cmd)} exited with code ${code}`));
    });
  });
}

async function fetchInfo(url: string, allowPlaylist: boolean): Promise<VideoInfo[]> {
  const args = ["--dump-single-json", "--flat-playlist", "--quiet", "--no-warnings"];
  if (!allowPlaylist) args.push("--no-playlist");
  args.push(url);

  const raw = await run(YTDLP, args, { capture: true });
  const data = JSON.parse(raw) as
    | (VideoInfo & { _type?: string; entries?: VideoInfo[] })
    | VideoInfo;

  if ("entries" in data && Array.isArray(data.entries)) {
    return data.entries.filter((e) => e?.id);
  }
  return [data as VideoInfo];
}

async function downloadOne(
  url: string,
  info: VideoInfo,
  stageDir: string,
  bitrate: string,
  cover: boolean,
): Promise<string> {
  const args = [
    "--no-playlist",
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", bitrate,
    "--embed-metadata",
    "--no-part",
    "--newline",
    "--progress",
    "--no-warnings",
    "--output", path.join(stageDir, "%(id)s.%(ext)s"),
  ];
  if (cover) args.push("--embed-thumbnail");
  args.push(url);

  await run(YTDLP, args);

  const staged = path.join(stageDir, `${info.id}.mp3`);
  if (!existsSync(staged)) {
    throw new Error(`yt-dlp finished but produced no MP3 for ${info.id}`);
  }
  return staged;
}

// -------------------------------------------------------------- preflight

async function preflight(dest: string): Promise<void> {
  if (!existsSync(YTDLP)) {
    fail(`yt-dlp not found at ${YTDLP}\n  Run: npm run setup`);
  }

  try {
    await run("ffmpeg", ["-version"], { capture: true });
  } catch {
    fail("ffmpeg not found on PATH — install it with: sudo apt install ffmpeg");
  }

  if (!existsSync(dest)) {
    fail(
      `Destination not found: ${dest}\n` +
        `  Is the watch plugged in and mounted? Check with: ls "/media/pol/PACE 3"`,
    );
  }

  const stat = await fs.stat(dest);
  if (!stat.isDirectory()) fail(`Destination is not a directory: ${dest}`);

  // Confirm the volume is actually writable — a COROS in the wrong USB mode
  // mounts read-only, which otherwise only surfaces at copy time.
  const probe = path.join(dest, `.write-probe-${process.pid}`);
  try {
    await fs.writeFile(probe, "");
    await fs.unlink(probe);
  } catch {
    fail(`Destination is not writable: ${dest}\n  Unlock the watch screen and re-plug the cable.`);
  }
}

async function freeSpace(dest: string): Promise<number> {
  const fsStat = await fs.statfs(dest);
  return fsStat.bavail * fsStat.bsize;
}

/** Existing files carry the video id in brackets, e.g. "Title [dQw4w9WgXcQ].mp3". */
async function findExisting(dest: string, id: string): Promise<string | null> {
  const entries = await fs.readdir(dest);
  return entries.find((e) => e.includes(`[${id}]`) && e.toLowerCase().endsWith(".mp3")) ?? null;
}

// ------------------------------------------------------------------- main

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dest: { type: "string", short: "d", default: DEFAULT_DEST },
      bitrate: { type: "string", short: "b", default: "192K" },
      playlist: { type: "boolean", default: false },
      cover: { type: "boolean", default: false },
      force: { type: "boolean", short: "f", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(`
  Download YouTube audio as MP3 onto a COROS Pace 3.

  Usage:
    npm run dl -- <url> [<url>...] [options]

  Options:
    -d, --dest <dir>      Destination folder
                          (default: ${DEFAULT_DEST})
    -b, --bitrate <rate>  MP3 bitrate, e.g. 128K, 192K, 256K  (default: 192K)
        --playlist        Download the whole playlist if the URL has one
                          (default: only the single video)
        --cover           Embed the thumbnail as album art (bigger files)
    -f, --force           Re-download even if the track is already on the watch
        --dry-run         Show what would happen, download nothing
    -h, --help            Show this help

  Examples:
    npm run dl -- "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    npm run dl -- "https://youtu.be/xyz" -b 256K
    npm run dl -- "https://youtube.com/playlist?list=abc" --playlist
`);
    process.exit(values.help ? 0 : 1);
  }

  const dest = path.resolve(values.dest!);
  const bitrate = values.bitrate!;
  const dryRun = values["dry-run"]!;

  if (!/^\d+K$/i.test(bitrate)) {
    fail(`Invalid bitrate "${bitrate}" — use a form like 128K, 192K or 256K.`);
  }

  await preflight(dest);
  log(`Destination: ${dest}`);
  log(`Free space:  ${formatBytes(await freeSpace(dest))}\n`);

  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "coros-dl-"));
  const cleanup = async (): Promise<void> => {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  };
  process.on("SIGINT", async () => {
    log("\nInterrupted — cleaning up staged files.");
    await cleanup();
    process.exit(130);
  });

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (const url of positionals) {
      let videos: VideoInfo[];
      try {
        videos = await fetchInfo(url, values.playlist!);
      } catch (err) {
        console.error(`✗ Could not read ${url}\n  ${(err as Error).message.split("\n")[0]}`);
        failed++;
        continue;
      }

      if (videos.length > 1) log(`Playlist: ${videos.length} tracks\n`);

      for (const info of videos) {
        const label = `${info.title} (${formatDuration(info.duration)})`;

        const existing = await findExisting(dest, info.id);
        if (existing && !values.force) {
          log(`↷ Already on watch: ${existing}`);
          skipped++;
          continue;
        }

        const finalName = `${sanitizeForFat32(info.title)} [${info.id}].mp3`;

        if (dryRun) {
          log(`→ Would download: ${label}\n  as ${finalName}`);
          downloaded++;
          continue;
        }

        log(`↓ ${label}`);
        try {
          // Per-video URL so playlist entries resolve independently.
          const videoUrl = `https://www.youtube.com/watch?v=${info.id}`;
          const staged = await downloadOne(videoUrl, info, stageDir, bitrate, values.cover!);

          const size = (await fs.stat(staged)).size;
          const available = await freeSpace(dest);
          if (size + FREE_SPACE_MARGIN > available) {
            throw new Error(
              `Not enough space on the watch: need ${formatBytes(size)}, ` +
                `${formatBytes(available)} free`,
            );
          }

          const target = path.join(dest, finalName);
          await fs.copyFile(staged, target);

          const copied = (await fs.stat(target)).size;
          if (copied !== size) {
            await fs.rm(target, { force: true });
            throw new Error(`Copy truncated (${copied} of ${size} bytes) — watch disconnected?`);
          }

          await fs.rm(staged, { force: true });
          log(`✓ ${finalName} — ${formatBytes(size)}\n`);
          downloaded++;
        } catch (err) {
          console.error(`✗ Failed: ${info.title}\n  ${(err as Error).message.split("\n")[0]}\n`);
          failed++;
        }
      }
    }
  } finally {
    await cleanup();
  }

  const parts = [`${downloaded} ${dryRun ? "to download" : "downloaded"}`];
  if (skipped) parts.push(`${skipped} already present`);
  if (failed) parts.push(`${failed} failed`);
  log(parts.join(", "));

  if (!dryRun && downloaded > 0) {
    log(`Free space now: ${formatBytes(await freeSpace(dest))}`);
    log("Eject the watch before unplugging it.");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  fail((err as Error).stack ?? String(err));
});
