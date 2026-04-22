# woid-skills — local models report

**Test date:** 2026-04-21T23:22:31-04:00
**Hardware:** NVIDIA RTX 3090 (24 GB VRAM), llama.cpp `:server-cuda`, `-ngl 99`, `--ctx-size 16384`
**Task:** Three-step scripted tutorial — `post.sh` → `room.sh move` → `state/update.sh`. All three calls must complete in order to pass. Fake HTTP bridge on `localhost:4455` records bodies.

## Scoring

| Milestone | Meaning |
|---|---|
| `tool_use` | Agent issued at least one bash call |
| `used_post` | `/internal/post` responded (post.sh equivalent) |
| `used_move` | `/internal/move` responded (room.sh move) |
| `used_state` | `/internal/state` responded (state/update.sh) |
| `all_three` | Full run, ordered, no retries needed |

## Results

_Auto-filled from `results-woid-skills.tsv` — see `scripts/fill-woid-report.sh` to regenerate._

| Model | Tier | Result | Progress | Run duration | Total (w/ load) | Bridge calls |
|---|---|---|---|---|---|---|
<!-- RESULTS_TABLE -->
| `gemma-4-E2B-it-Q4_K_M` | edge | ✅ pass | all_three | 12s | 19s | 3 |
| `gemma-4-E4B-it-Q4_K_M` | edge | ✅ pass | all_three | 13s | 21s | 3 |
| `qwen3.5-9b-Q4_K_M` | 8-12gb-vram | ✅ pass | all_three | 15s | 77s | 3 |
| `hermes-3-llama-3.1-8b-Q4_K_M` | 8-12gb-vram | ❌ fail | none | 29s | 82s | 0 |
| `gemma-4-26B-A4B-it-Q4_K_M` | 16gb-vram | ✅ pass | all_three | 21s | 244s | 3 |
| `gemma-4-31B-it-Q4_K_M` | 24gb-vram | ✅ pass | all_three | 26s | 270s | 3 |
| `qwen3.6-35B-A3B-Q4_K_M` | 24gb-vram | ✅ pass | all_three | 13s | 305s | 3 |


## Per-model notes

<!-- PER_MODEL_NOTES -->

### `gemma-4-E2B-it-Q4_K_M` — ✅ PASS

- **Tier:** edge · **Params:** 2B total / 2B active · **Context:** 131072
- **Progress:** reached `all_three`, bridge received 3/3 calls
- **Timing:** agent run 12s, total 19s (incl. download + load + swap)
- **Notes:** Smallest Gemma 4, Apache 2.0, agentic edge model, ~2GB Q4_K_M

### `gemma-4-E4B-it-Q4_K_M` — ✅ PASS

- **Tier:** edge · **Params:** 4B total / 4B active · **Context:** 131072
- **Progress:** reached `all_three`, bridge received 3/3 calls
- **Timing:** agent run 13s, total 21s (incl. download + load + swap)
- **Notes:** Gemma 4 E4B, Apache 2.0, interleaved thinking during function calls, ~5GB Q4_K_M

### `qwen3.5-9b-Q4_K_M` — ✅ PASS

- **Tier:** 8-12gb-vram · **Params:** 9B total / 9B active · **Context:** 131072
- **Progress:** reached `all_three`, bridge received 3/3 calls
- **Timing:** agent run 15s, total 77s (incl. download + load + swap)
- **Notes:** Dense 9B, Apache 2.0, strong HumanEval, mature tool calling

### `hermes-3-llama-3.1-8b-Q4_K_M` — ❌ fail

- **Tier:** 8-12gb-vram · **Params:** 8B total / 8B active · **Context:** 131072
- **Progress:** reached `none`, bridge received 0/3 calls
- **Timing:** agent run 29s, total 82s (incl. download + load + swap)
- **Notes:** Llama 3.1 base, specialized for function calling + structured output, ChatML

### `gemma-4-26B-A4B-it-Q4_K_M` — ✅ PASS

- **Tier:** 16gb-vram · **Params:** 26B total / 4B active · **Context:** 131072
- **Progress:** reached `all_three`, bridge received 3/3 calls
- **Timing:** agent run 21s, total 244s (incl. download + load + swap)
- **Notes:** Gemma 4 MoE, fast inference (4B active), ~15GB Q4_K_M

### `gemma-4-31B-it-Q4_K_M` — ✅ PASS

- **Tier:** 24gb-vram · **Params:** 31B total / 31B active · **Context:** 131072
- **Progress:** reached `all_three`, bridge received 3/3 calls
- **Timing:** agent run 26s, total 270s (incl. download + load + swap)
- **Notes:** Gemma 4 dense, #3 Arena open leaderboard, ~18GB Q4_K_M

### `qwen3.6-35B-A3B-Q4_K_M` — ✅ PASS

- **Tier:** 24gb-vram · **Params:** 35B total / 3.6B active · **Context:** 131072
- **Progress:** reached `all_three`, bridge received 3/3 calls
- **Timing:** agent run 13s, total 305s (incl. download + load + swap)
- **Notes:** Qwen 3.6 MoE, MCPMark tool-call leader, ~22GB Q4_K_M, 3.6B active


## Methodology

- **Harness**: `nim-skill-test` with a new `woid-skills` test config (`src/run.ts`, `woid-skill.md`)
- **Bash tool**: custom `createDockerBashTool` — each agent runs inside a disposable `ubuntu:24.04` container with `--network host`. Replaces `pi-coding-agent`'s built-in `createBashTool`, which as of v0.30.2 dropped the `{operations}` parameter and could not be pointed at Docker.
- **Fake bridge**: tiny Node HTTP server (`src/woid-bridge.ts`) on `localhost:4455`. Each endpoint returns `{ok, kind, seq, received}` — the `"kind":"<x>"` marker is what the progress detector grep-matches in the tool's curl output.
- **llama.cpp**: standalone compose stack (`compose.llama-cpp.yml`) swapped model-by-model via `scripts/swap-local-model.sh`. One model in VRAM at a time; runner mutex serializes local agent calls anyway.
- **Catalog**: `src/local-models.json` (7 entries at time of report). All Apache 2.0 / permissively licensed. All Q4_K_M unless noted.
- **Sweep**: `scripts/sweep-local-woid-skills.sh` — iterates the catalog, writes TSV + per-model log under `logs/woid-skills/`.

## Reproducing

```bash
cp .env.example .env   # NVIDIA_NIM_API_KEY optional; not needed for local
npm install
./scripts/install-nvidia-container-toolkit.sh   # one-time, sudo
./scripts/sweep-local-woid-skills.sh             # full sweep
./scripts/sweep-local-woid-skills.sh gemma-4-E4B-it-Q4_K_M   # single model
```

Results land in `results-woid-skills.tsv`; per-model stdout+stderr in `logs/woid-skills/<id>.log`.

## Headline findings

- **6 / 7 local models passed** the full three-step tutorial. Every Gemma 4
  variant (E2B → 31B) and both Qwen families (3.5-9B, 3.6-35B-A3B) completed
  all three bridge calls in order on the first attempt.
- **Agent run time ranges 12–26 s** across the passing models — well within
  interactive budgets for a woid-sandbox character turn. The bottleneck is
  one-shot model loading (15–290 s depending on size + cache state), not
  per-turn inference.
- **Smallest viable model: Gemma 4 E2B at Q4_K_M (~2 GB VRAM, 12 s run)**.
  Recommended default for a "cheap local" slot next to NIM and Gemini in the
  sandbox — runs on a laptop iGPU, CPU-only fallback works.
- **Hermes 3 Llama 3.1 8B is the only failure**. It hallucinated fake curl
  responses in text instead of emitting OpenAI-format tool calls. Root
  cause: Nous's chat template expects the function schema inlined in the
  system prompt with `<tool_call>` tags, not OpenAI's `tools` field. llama.cpp
  `--jinja` alone does not bridge the format. Fixable, but not out-of-the-box.
- **All Gemma 4 variants pass identically**. For this task there's no quality
  payoff moving from E2B → 31B. Pick the size that fits the VRAM budget
  alongside your KV cache + other workloads.
- **Qwen 3.6 35B-A3B is viable on a 24 GB GPU** at Q4_K_M with `--ctx-size 16384`.
  Passed with 13 s run time — MoE activation (3.6 B) keeps inference cheap
  despite the 35 B total weight.

## Recommendations for woid-sandbox

1. **Wire Gemma 4 E2B and E4B into `woid-sandbox/pi-bridge` as a third
   provider** alongside NIM and Gemini. Both completed the tutorial in <15 s
   run time — fast enough for character turns triggered by room events.
2. **Keep a larger Gemma 4 option (26B-A4B or 31B)** for more complex
   scenarios once we build trigger-inference tests. Equivalent quality, more
   reasoning headroom.
3. **Skip Hermes 3 unless we're willing to customize the system prompt**
   with Nous's tool-call JSON schema. Not worth it when Gemma 4 E2B is
   smaller *and* works out of the box.
4. **The docker-bash-tool workaround is load-bearing** — upstream
   `pi-coding-agent` doesn't support pointing `bash` at a Docker container
   any more. We should either upstream the fix or keep carrying it locally.

## What the test *doesn't* exercise

- Multi-turn trigger handling (our runner sends a single prompt and reads one end-to-end response). The real woid sandbox fires `spawn`/`arrival`/`message_received` triggers at different times.
- Role-play fidelity — whether the agent writes in-character. Here we just want to see well-formed curl commands.
- Skill discovery under `.pi/skills` — pi's own skill-loading path is bypassed; we inline the tutorial in the system prompt.
- Tool-call *intent* when it's not obvious what to call. This test is deliberately "follow the manual." The next rung up is a scenario where the right tool isn't named — e.g. "someone said hi, respond" and see whether the model picks `post.sh`.

## Next steps

- Extend the test with a second scenario where tool selection requires inference, not transcription (no explicit "call post.sh" — just a trigger).
- Add Qwen 3.5 family (4B, 27B), Phi-4 series, and any Llama 3.3-Instruct GGUFs with native tool calling for a broader sweep.
- For the best 2–3 local models, wire them into `woid-sandbox/pi-bridge` as a third provider alongside NIM + Gemini.
