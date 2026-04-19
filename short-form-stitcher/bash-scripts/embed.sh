#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./embed_whisper_transcripts.sh "/path/to/folder"
#
# What it does:
#   - scans the top level of the provided folder for video files
#   - runs Whisper transcription on each file
#   - creates a copy in:
#       {input-folder}/transcription-embedded/{original filename}
#   - writes the transcript into embedded metadata (comment/description) and
#     sets the macOS Finder "Get Info → Comments" field (Finder comment),
#     which is separate from QuickTime/ffmpeg metadata and is what Finder shows.
#
# Requirements:
#   - whisper must be on PATH
#   - ffmpeg must be on PATH
#   - /usr/bin/python3 (Finder comments; standard on macOS)
#   - Finder comments require a normal GUI login (osascript → Finder).

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 \"/path/to/folder\""
  exit 1
fi

SOURCE_DIR="$1"
OUTPUT_DIR="$SOURCE_DIR/transcription-embedded"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/whisper-embed.XXXXXX")"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "Error: directory does not exist: $SOURCE_DIR"
  exit 1
fi

if ! command -v whisper >/dev/null 2>&1; then
  echo "Error: whisper command not found on PATH"
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Error: ffmpeg command not found on PATH"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Finder’s Get Info “Comments” is a Finder comment, not embedded video metadata.
# Write the text to a temp file and let AppleScript read it (avoids bash quoting and $ expansion).
set_finder_comment() {
  local target="$1"
  local body="$2"
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi
  local max_len=60000
  if [[ ${#body} -gt $max_len ]]; then
    body="${body:0:$((max_len - 1))}…"
  fi
  local cfile="$TMP_DIR/finder-comment.$$.$RANDOM.txt"
  if ! printf '%s' "$body" >"$cfile"; then
    return 1
  fi
  if ! /usr/bin/python3 - "$target" "$cfile" <<'PY'
import os
import subprocess
import sys


def esc_applescript_string(p: str) -> str:
    return p.replace("\\", "\\\\").replace('"', '\\"')


target = sys.argv[1]
cpath = sys.argv[2]
script = (
    'tell application "Finder"\n'
    f'\tset comment of (POSIX file "{esc_applescript_string(target)}" as alias) to '
    f'(read POSIX file "{esc_applescript_string(cpath)}" as «class utf8»)\n'
    "end tell\n"
)
try:
    r = subprocess.run(
        ["/usr/bin/osascript", "-e", script],
        capture_output=True,
        text=True,
        check=False,
    )
finally:
    try:
        os.remove(cpath)
    except OSError:
        pass
sys.exit(0 if r.returncode == 0 else 1)
PY
  then
    rm -f "$cfile"
    return 1
  fi
  return 0
}

# List files without a stdin pipe to the loop body: Whisper/Python and ffmpeg
# inherit stdin; if they read it, they steal bytes from the same stream `read`
# uses and later paths break (e.g. /Volumes/... -> olumes/...). Whisper: </dev/null;
# ffmpeg: -nostdin. Process substitution avoids an extra pipeline subshell.
while IFS= read -r -d '' file; do
  filename="$(basename "$file")"
  stem="${filename%.*}"
  ext="${filename##*.}"
  ext_lower="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"

  transcript_txt="$TMP_DIR/$stem.txt"
  output_file="$OUTPUT_DIR/$filename"

  echo "Transcribing: $filename"

  if ! whisper "$file" \
    --model turbo \
    --language English \
    --task transcribe \
    --output_format txt \
    --output_dir "$TMP_DIR" </dev/null; then
    echo "Skipping (Whisper failed): $filename"
    continue
  fi

  if [[ ! -f "$transcript_txt" ]]; then
    echo "Skipping (Transcript file missing): $filename"
    continue
  fi

  # Flatten transcript into a single metadata-safe line
  transcript="$(tr '\n' ' ' < "$transcript_txt" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"

  echo "Embedding transcript into metadata: $filename"

  case "$ext_lower" in
    mov|mp4|m4v)
      if ffmpeg -nostdin -y -i "$file" -map 0 -c copy \
        -movflags use_metadata_tags \
        -metadata comment="$transcript" \
        -metadata description="$transcript" \
        "$output_file" >/dev/null 2>&1; then
        if set_finder_comment "$output_file" "$transcript"; then
          echo "Finished: $output_file"
        else
          echo "Finished (embedded metadata only; Finder comment not set): $output_file"
        fi
      else
        echo "Failed to write metadata: $filename"
      fi
      ;;
    *)
      if ffmpeg -nostdin -y -i "$file" -map 0 -c copy \
        -metadata comment="$transcript" \
        -metadata description="$transcript" \
        "$output_file" >/dev/null 2>&1; then
        if set_finder_comment "$output_file" "$transcript"; then
          echo "Finished: $output_file"
        else
          echo "Finished (embedded metadata only; Finder comment not set): $output_file"
        fi
      else
        echo "Failed to write metadata: $filename"
      fi
      ;;
  esac
done < <(find "$SOURCE_DIR" \
  -maxdepth 1 \
  -type f \
  ! -name '._*' \
  \( -iname "*.mov" -o -iname "*.mp4" -o -iname "*.m4v" -o -iname "*.mpg" -o -iname "*.mpeg" -o -iname "*.avi" -o -iname "*.mkv" -o -iname "*.webm" \) \
  -print0)

echo "All done."
echo "Output folder: $OUTPUT_DIR"