# nim-skill-test

Test how well NIM-hosted LLMs can autonomously follow a multi-step skill document — using only bash, curl, python3, and ssh-keygen in a fresh Docker container.

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch): one file to edit, one metric, autonomous iteration.

## Two benchmark tests

| Test | Task | Milestones |
|------|------|------------|
| **apocalypse-radio** | Register on GitLab, create PAT, add SSH key, authenticate on game server | `tool_use → fetched_signup → registered → pat_created → ssh_key → authenticated` |
| **moltbook** | Register on Moltbook, create a post, solve verification challenge | `tool_use → fetched_skill → registered → posted → verified` |

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

## Current best: 14/27 (52%) apocalypse-radio

## License

MIT
