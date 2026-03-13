# nim-skill-test

Test how well NIM-hosted LLMs can autonomously follow a multi-step skill document to register on GitLab and authenticate on a game server — using only bash, curl, python3, and ssh-keygen in a fresh Docker container.

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch): one file to edit, one metric, autonomous iteration.

## How it works

The repo has three files that matter:

- **`skill.md`** — the instructions 21 NIM models try to follow. **This file is edited and iterated on by the agent.**
- **`program.md`** — instructions for the AI agent doing the optimization. **This file is edited and iterated on by the human.**
- **`src/run.ts`** — the test runner + dashboard. Not modified during experiments.

Each experiment tests 21 models (12B–1T params) in fresh Docker containers. The metric is **pass_rate** — how many models obtain a game token. The agent modifies `skill.md`, runs the test, keeps or discards based on results, and repeats.

## Quick start

```bash
cp .env.example .env     # add your NVIDIA_NIM_API_KEY
npm install

# Manual single run:
npx tsx src/run.ts --all

# Or: point your AI agent at program.md and let it iterate
```

Dashboard at http://localhost:3457

## Running the agent

Spin up Claude Code (or similar) in this repo, then prompt:

```
Have a look at program.md and let's kick off a new experiment! Let's do the setup first.
```

The agent will create an experiment branch, establish a baseline, then autonomously iterate on `skill.md` to improve pass_rate — modifying, testing, keeping improvements, discarding regressions.

## Project structure

```
skill.md        — agent instructions for NIM models (agent modifies this)
program.md      — instructions for the optimizing agent (human modifies this)
src/run.ts      — test runner + dashboard (do not modify)
src/models.json — 21 NIM model catalog (do not modify)
src/db.ts       — SQLite persistence
src/docker-bash-ops.ts — Docker container management
results.tsv     — experiment log (auto-populated, not committed)
```

## Requirements

- Docker
- GitLab instance at gitlab.crux.casa
- Game server at localhost:2567
- NVIDIA NIM API key

## Current best: 3/21 (14%)

Passing models: qwen3.5-397b, deepseek-v3.2, mistral-large-675b

## License

MIT
