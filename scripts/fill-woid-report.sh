#!/usr/bin/env bash
# Render results-woid-skills.tsv into docs/woid-skills-report.md.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$HERE/scripts/fill-woid-report.py"
