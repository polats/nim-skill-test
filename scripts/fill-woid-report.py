#!/usr/bin/env python3
"""Render results-woid-skills.tsv into docs/woid-skills-report.md."""
import csv, json, re, pathlib, datetime

HERE = pathlib.Path(__file__).resolve().parent.parent
TSV = HERE / "results-woid-skills.tsv"
CATALOG = HERE / "src/local-models.json"
REPORT = HERE / "docs/woid-skills-report.md"

if not TSV.exists():
    raise SystemExit(f"no {TSV} yet — run the sweep first")

cat = {m["id"]: m for m in json.loads(CATALOG.read_text())}
rows = list(csv.reader(TSV.open(), delimiter="\t"))
body = rows[1:]

ICONS = {"pass": "✅", "fail": "❌", "error": "⚠️", "load-timeout": "⏱️", "unknown": "·"}

table_lines = []
for r in body:
    model, result, progress, dur, total, bridge, ts = (r + [""] * 7)[:7]
    m = cat.get(model, {})
    tier = m.get("tier", "?")
    icon = ICONS.get(result, "·")
    table_lines.append(
        f"| `{model}` | {tier} | {icon} {result} | {progress} | {dur} | {total}s | {bridge} |"
    )
# Header only if we have rows — otherwise placeholder
if table_lines:
    table_header = "| Model | Tier | Result | Progress | Run duration | Total (w/ load) | Bridge calls |\n|---|---|---|---|---|---|---|"
    # The table header is already in the template; we just append rows below it.
    table_block = "\n".join(table_lines)
else:
    table_block = "_(no rows yet)_"

notes_lines = []
for r in body:
    model, result, progress, dur, total, bridge, ts = (r + [""] * 7)[:7]
    m = cat.get(model, {})
    passed = result == "pass" and progress == "all_three"
    badge = "✅ PASS" if passed else f"❌ {result}"
    notes_lines.append(f"### `{model}` — {badge}")
    notes_lines.append("")
    notes_lines.append(
        f"- **Tier:** {m.get('tier','?')} · **Params:** "
        f"{m.get('total_params_b','?')}B total / {m.get('active_params_b','?')}B active · "
        f"**Context:** {m.get('context_window','?')}"
    )
    notes_lines.append(
        f"- **Progress:** reached `{progress}`, bridge received {bridge}/3 calls"
    )
    notes_lines.append(
        f"- **Timing:** agent run {dur}, total {total}s (incl. download + load + swap)"
    )
    if m.get("notes"):
        notes_lines.append(f"- **Notes:** {m['notes']}")
    notes_lines.append("")
notes_block = "\n".join(notes_lines).rstrip() + "\n"

today = datetime.datetime.now().astimezone().isoformat(timespec="seconds")

text = REPORT.read_text()
text = re.sub(
    r"^\*\*Test date:\*\*.*$",
    f"**Test date:** {today}",
    text,
    count=1,
    flags=re.M,
)
text = re.sub(
    r"<!-- RESULTS_TABLE -->.*?(?=\n## )",
    f"<!-- RESULTS_TABLE -->\n{table_block}\n\n",
    text,
    flags=re.S,
)
text = re.sub(
    r"<!-- PER_MODEL_NOTES -->.*?(?=\n## )",
    f"<!-- PER_MODEL_NOTES -->\n\n{notes_block}\n",
    text,
    flags=re.S,
)
REPORT.write_text(text)
print(f"Rendered -> {REPORT}")
