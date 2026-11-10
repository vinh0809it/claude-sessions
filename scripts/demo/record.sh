#!/usr/bin/env bash
# Re-records docs/demo.gif from fake sessions (no real data). Needs python3 + Pillow, ffmpeg.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/../.."
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/frames" "$W/bin"; cp "$HERE/bin/claude" "$W/bin/"
python3 -I "$HERE/make_data.py" "$W"
python3 -I "$HERE/record.py" "$W" "$ROOT/bin/claude-sessions.js"
ffmpeg -loglevel error -y -f concat -safe 0 -i "$W/frames.txt" \
  -vf "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" \
  -loop 0 "$ROOT/docs/demo.gif"
echo "wrote docs/demo.gif"
