# nim-skill-test

Test how well NIM-hosted LLMs can autonomously follow a multi-step skill document — using only bash, curl, python3, and ssh-keygen in a fresh Docker container.

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch): one file to edit, one metric, autonomous iteration.

## Benchmark tests

Two live in this repo (Docker-sandboxed, multi-step skill.md):

| Test | Task | Milestones |
|------|------|------------|
| **apocalypse-radio** | Register on GitLab, create PAT, add SSH key, authenticate on game server | `tool_use → fetched_signup → registered → pat_created → ssh_key → authenticated` |
| **moltbook** | Register on Moltbook, create a post, solve verification challenge | `tool_use → fetched_skill → registered → posted → verified` |

Two lighter tests live in a sibling repo ([polats/apoc-radio-v2](https://github.com/polats/apoc-radio-v2), at `app/apps/api/scripts/bench/`). They skip Docker and hit NIM's chat API directly — scoring a single-turn output via structural lint:

| Test | Task | Milestones |
|------|------|------------|
| **profile** | Emit one JSON object for `POST /api/agents` with `callSign`, `displayName`, `bio`, `stylePrompt` | `received → parseable_json → has_required_fields → callSign_format_ok → stylePrompt_long_enough → mentions_bank` |
| **strudel** | Emit a single Strudel expression — JS pattern language for the apoc-radio feed | `received → parseable → parens_balanced → uses_stack_or_s → drums_banked → ends_with_cpm` |

The sibling bench also auto-discovers the NIM catalog at run time (`bench:discover` → `GET /v1/models`) so the model list can't drift like the hardcoded `src/models.json` here. Full 2026-04-18 scorecard + methodology: [`docs/model-benchmark.md`](https://github.com/polats/apoc-radio-v2/blob/main/docs/model-benchmark.md).

## How it works

Each experiment launches 27 NIM models (12B–1T params) in fresh Docker containers. Each model gets a bash tool and the skill.md instructions, then tries to complete the task autonomously.

The dashboard tracks:
- **Pass rate** — how many models obtain a game token / verify a post
- **Progress milestones** — how far each model got before failing
- **Experiment log** — auto-logged per run with git commit hash

Key files:

```
skill.md             — apocalypse-radio instructions (iterate on this)
moltbook-skill.md    — moltbook instructions
src/run.ts           — test runner + dashboard
src/models.json      — 27 NIM model catalog
src/db.ts            — SQLite persistence (runs, agents, experiments, progress)
src/docker-bash-ops.ts — Docker container management
```

## Quick start

```bash
cp .env.example .env     # add your NVIDIA_NIM_API_KEY
npm install

# Run apocalypse-radio test (default):
npx tsx src/run.ts --all

# Run moltbook test:
npx tsx src/run.ts --test=moltbook --all

# Dashboard only (launch runs manually from UI):
npx tsx src/run.ts
```

Dashboard at http://localhost:3457

### Local models (llama.cpp)

Runs open-weights models through an OpenAI-compat llama.cpp server. One model
in VRAM at a time; runs are serialized via a mutex so NIM/HF keep parallelism.

```bash
# 1. pick a model from src/local-models.json and launch llama-server:
./scripts/swap-local-model.sh gemma-4-E4B-it-Q4_K_M

# 2. point the runner at it + restrict the batch to local:
export LOCAL_LLM_BASE_URL=http://localhost:18080/v1
export LOCAL_LLM_MODEL=gemma-4-E4B-it-Q4_K_M
npx tsx src/run.ts --provider=local --all
```

Swap models by re-running the script. For CUDA, edit `compose.llama-cpp.yml`
to use `:server-cuda` and uncomment the GPU deploy block.

## Features

- **Progress tracking** — milestones per agent, not just pass/fail
- **False-positive-resistant detectors** — filters out documentation examples and markdown content
- **Retry logic** — retries agents that fail before making tool calls (network issues vs model capability)
- **Experiment log** — auto-logged with git commit, pass rate, and status (keep/discard/crash)
- **Concurrency control** — rate-limited API calls, configurable parallelism

## Requirements

- Docker
- GitLab instance at gitlab.crux.casa (for apocalypse-radio)
- Game server at localhost:2567 (for apocalypse-radio)
- NVIDIA NIM API key

## Current best: 15/27 (56%) apocalypse-radio

Consistent passers: deepseek-v3.x, qwen3.5-x, glm4/5, kimi-k2.5, step-3.5-flash, gpt-oss-120b, qwen3-coder, mistral-large-675b

### Sibling bench (`apoc-radio-v2` · 2026-04-18)

Out of 23 NIM candidates auto-discovered from the catalog, 14 pass both `profile` and `strudel` skills reliably. Top picks:

| Model | profile | strudel |
|---|---|---|
| `qwen/qwen2.5-coder-32b-instruct` | 100% · 3.3s | 100% · 1.9s |
| `meta/llama-3.3-70b-instruct` | 100% · 4.5s | 100% · 2.0s |
| `google/gemma-3-27b-it` | 100% · 4.9s | 100% · 2.1s |
| `meta/llama-4-maverick-17b-128e-instruct` | 100% · 6.6s | 100% · 4.4s |
| `qwen/qwen3-next-80b-a3b-instruct` | 100% · 4.2s | 100% · 1.8s |
| `qwen/qwen3.5-122b-a10b` | 100% · 9.3s | 100% · 2.5s |
| `microsoft/phi-4-mini-instruct` | 92% · 2.6s | 100% · 1.5s (fastest) |

Interesting drift: the sibling's `strudel` skill initially saw models fall back to Tidal/Haskell syntax (`d1 $ n #`) when just told "Strudel" — fixed by prepending a concrete JS example to every system prompt. `.reverb(X)` → `.room(X)` sanitizer added in extraction.

## License

MIT
