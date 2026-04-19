#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $(basename "$0") /path/to/dir" >&2
  exit 2
fi

IN_DIR="$1"
OUT_DIR="${IN_DIR%/}/remove-last-frame"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (install it first)" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe not found (install it first)" >&2; exit 1; }

mkdir -p "$OUT_DIR"

shopt -s nullglob
found=0

for f in "$IN_DIR"/*.mov "$IN_DIR"/*.MOV; do
  [[ -f "$f" ]] || continue
  found=1

  base="$(basename "$f")"
  out="$OUT_DIR/$base"

  has_audio="$(ffprobe -v error -select_streams a:0 -show_entries stream=index -of default=nw=1:nk=1 "$f" | tr -d '\r')"

  # Count video frames and get fps
  frames="$(ffprobe -v error -count_frames -select_streams v:0 \
    -show_entries stream=nb_read_frames -of default=nw=1:nk=1 "$f" | tr -d '\r')"

  fps_ratio="$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=r_frame_rate -of default=nw=1:nk=1 "$f" | tr -d '\r')"

  if [[ -z "${frames:-}" || "$frames" == "N/A" || "$frames" -lt 2 ]]; then
    echo "Skipping (can't count frames or too short): $f" >&2
    continue
  fi

  end_frame=$((frames - 1))

  # Convert fps ratio (e.g. 30000/1001) to float seconds
  end_time="$(
    awk -v fr="$fps_ratio" -v n="$end_frame" '
      BEGIN{
        split(fr,a,"/");
        fps = (a[2] == "" ? a[1] : a[1]/a[2]);
        if (fps <= 0) exit 1;
        printf "%.6f", (n / fps);
      }'
  )"

  tmp_base="$(mktemp -t "remove-last-frame.XXXXXX")"
  tmp="${tmp_base}.mov"
  trap 'rm -f "$tmp_base" "$tmp"' EXIT

  if [[ -n "${has_audio:-}" ]]; then
    ffmpeg -hide_banner -y -i "$f" \
      -filter_complex \
        "[0:v]trim=end_frame=${end_frame},setpts=PTS-STARTPTS[v]; \
         [0:a]atrim=end=${end_time},asetpts=PTS-STARTPTS[a]" \
      -map '[v]' -map '[a]' -map '0:d?' \
      -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 18 \
      -c:a aac -b:a 320k \
      -c:d copy \
      -movflags +faststart \
      "$tmp"
  else
    ffmpeg -hide_banner -y -i "$f" \
      -vf "trim=end_frame=${end_frame},setpts=PTS-STARTPTS" \
      -map '0:v:0' -map '0:d?' \
      -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 18 \
      -c:d copy \
      -movflags +faststart \
      "$tmp"
  fi

  mv -f "$tmp" "$out"
  rm -f "$tmp_base" "$tmp"
  trap - EXIT

  echo "Wrote: $out"
done

if [[ $found -eq 0 ]]; then
  echo "No .mov files found in: $IN_DIR" >&2
  exit 1
fi