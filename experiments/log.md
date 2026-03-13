# Experiment Log

## Metric

**pass_rate** = models that obtain a game token / total models tested

Each run tests 21 NIM models (12B–1T params) on a 4-step task:
1. Register on GitLab (CSRF + form POST)
2. Create Personal Access Token
3. Generate SSH key + add to GitLab
4. SSH challenge-response auth on game server

Budget: 30 tool calls max per model. RPM limit: 38.

---

## Run 1 — Baseline (fresh containers, no CLI)

**Date:** 2026-03-13
**Commit:** (pre-git)
**pass_rate: 0/21 (0%)**

- Containers: `node:20-slim` with volume-mounted CLI
- skill.md: full 475-line version with CLI commands
- Bug: single-quote escaping in docker-bash-ops.ts corrupted every command
- All 21 models failed — 100% caused by escaping bug

## Run 2 — Escaping fix + skill.md rewrite v1

**Date:** 2026-03-13
**Commit:** (pre-git)
**pass_rate: 1/21 (5%)**

Changes:
- Fixed `command.replace(/'/g, "'\\''")` — removed since `spawn()` passes args directly
- Rewrote skill.md: removed CLI, curl-only, python3 for CSRF extraction
- Container: `ubuntu:24.04`, install `curl python3 openssh-client git openssl`

Results:
- PASS: qwen/qwen3.5-397b-a17b
- Main failure: variable scope loss — models set vars in one tool call, empty in next

## Run 3 — File-based state persistence

**Date:** 2026-03-13
**Commit:** (pre-git)
**pass_rate: 3/21 (14%)**

Changes:
- Rewrote skill.md with file-based state: `echo "$VAR" > /tmp/file.txt` / `VAR=$(cat /tmp/file.txt)`
- Added `requiresToolResultName: true` to NIM model compat
- maxTokens: 2048 → 4096 (devstral was truncating tool calls)

Results:
- PASS: qwen/qwen3.5-397b-a17b, deepseek-ai/deepseek-v3.2, mistralai/mistral-large-3-675b
- ~10 models produce 0 tool calls (gemma, qwq, nemotron, mixtral, etc.)

## Run 4 — Split Step 1a/1b

**Date:** 2026-03-13
**Commit:** (pre-git)
**pass_rate: 3/21 (14%)**

Changes:
- Split Step 1 into 1a (fetch CSRF) and 1b (register) for shorter code blocks
- maxTokens confirmed at 4096

Results:
- Same 3 models pass. No improvement — ran with stale cached skill.md (process not restarted)

## Run 5 — Nudge logic + auth prompt + heredoc scripts

**Date:** 2026-03-13
**pass_rate: 1/21+ (in progress)**

Changes:
- System prompt: "authorized test environment", explicit "MUST use bash tool"
- Added nudge retry: if 0 tool calls after prompt, re-prompt up to 3x
- skill.md: python scripts written to files via heredoc instead of `python3 -c "..."`

Observations:
- Models now making tool calls (llama-3.3 went from 0→16 calls)
- New failure: heredocs in tool calls break — models truncate the delimiter
- Models collapse multi-line scripts to single-line, breaking embedded python regex
- llama-3.1-70b refused: "I can't help with registering"

## Key Findings

### What works:
- File-based state persistence (variables don't persist between tool calls)
- python3 for extraction instead of `grep -oP` with Perl regex
- Prescriptive system prompt with numbered steps
- Larger maxTokens (4096) prevents tool call truncation
- Only large models (>100B active params) reliably pass

### What doesn't work:
- Heredocs in tool call arguments (models truncate them)
- `python3 -c "..."` with regex containing quotes/parens (breaks when linearized)
- `grep -oP '\K'` patterns (escape-hell loops)
- Complex multi-line commands (models collapse to single line)
- Small models (<30B) producing valid tool calls via NIM API

### Models that never produce tool calls:
gemma-3-27b, gemma-3-12b, nemotron-49b-v1, nemotron-49b-v1.5, qwq-32b,
maverick-17b, ministral-14b — likely NIM API tool calling compat issues
