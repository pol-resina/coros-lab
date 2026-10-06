# coros-lab

Download YouTube audio as MP3 straight onto a COROS Pace 3.

## Setup

Once, to vendor the `yt-dlp` binary into `./bin` (no `sudo` needed):

```bash
npm install
npm run setup
```

`ffmpeg` must be on your PATH — it already is on this machine.

## Usage

Plug in the watch, unlock the screen, wait for it to mount, then:

```bash
npm run dl -- "https://www.youtube.com/watch?v=VIDEO_ID"
```

The `--` is required — it passes the arguments through npm to the script.

### Options

| Flag | Default | What it does |
| --- | --- | --- |
| `-d, --dest <dir>` | `/media/pol/PACE 3/Music/Default` | Destination folder |
| `-b, --bitrate <rate>` | `192K` | MP3 bitrate — `128K`, `192K`, `256K` |
| `--playlist` | off | Download the whole playlist, not just the one video |
| `--cover` | off | Embed the thumbnail as album art (bigger files) |
| `-f, --force` | off | Re-download even if the track is already on the watch |
| `--dry-run` | off | Show what would happen, download nothing |

### Examples

```bash
# One track
npm run dl -- "https://youtu.be/VIDEO_ID"

# Several at once, at higher quality
npm run dl -- "https://youtu.be/AAA" "https://youtu.be/BBB" -b 256K

# A whole playlist
npm run dl -- "https://youtube.com/playlist?list=PLxxx" --playlist

# Check first without downloading
npm run dl -- "https://youtu.be/VIDEO_ID" --dry-run
```

## How it works

Tracks are downloaded and transcoded in a local temp folder, and only copied to
the watch once the MP3 is complete. A failed or cancelled download therefore
never leaves a half-written file on the watch — which matters, because the Pace
3's FAT32 volume has no journal and the music player skips corrupt files
silently.

Other details worth knowing:

- **Where files go.** COROS keeps music in `Music/<playlist>/`, not in `Music/`
  directly. `Default` is the built-in playlist and the script's default target.
  New folders under `Music/` show up as separate playlists on the watch.
- **Filenames** are sanitized for FAT32 (`\ / : * ? " < > |` become `-`, trailing
  dots and spaces stripped, capped at 120 characters). Accents and emoji survive
   — the volume is mounted UTF-8.
- **Duplicates** are detected by the YouTube video id in the filename, using the
  `Title [VIDEO_ID].mp3` convention your existing library already follows. Rerunning
  the same URL skips it instead of making a `(1)` copy.
- **ID3 tags** (title, artist) are embedded so the watch shows real names rather
  than filenames.
- **Space** is checked before each copy, keeping a 50 MB margin so the volume
  never fills completely.

Eject the watch properly before unplugging — the volume is mounted with `flush`,
but the copy is only guaranteed on unmount.

## Maintenance

YouTube changes its internals often; when downloads start failing, update first:

```bash
npm run update-ytdlp
```

## Note

Use this for content you have the right to download — your own uploads,
Creative Commons tracks, or material whose licence permits it.
