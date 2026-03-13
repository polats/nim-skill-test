# nim-skill-test

Test how well NIM-hosted LLMs can autonomously follow a multi-step skill document to register on GitLab and authenticate on a game server — using only bash, curl, python3, and ssh-keygen in a fresh Docker container.

Inspired by [karpathy/autoresearch](https://github.com/karpathy/autoresearch): minimal files, one metric, iterate fast.

## Structure

```
nim-skill-test/
├── skill.md              # The agent program — instructions LLMs follow (human-modified)
├── src/
│   ├── run.ts            # Test runner + dashboard (agent-modified)
│   ├── docker-bash-ops.ts # Docker container management
│   ├── db.ts             # SQLite persistence
│   └── models.json       # NIM model catalog (21 models, 12B–1T params)
├── experiments/
│   └── log.md            # Experiment results log
├── .env                  # NVIDIA_NIM_API_KEY (not committed)
└── .env.example
```

## Metric

**pass_rate** = models that obtain a game token / 21 total models

Each model gets a fresh Ubuntu 24.04 container, 30 tool calls max, and must:
1. Register on GitLab (CSRF extraction + form POST)
2. Create a Personal Access Token
3. Generate SSH key + add to GitLab
4. Authenticate via SSH challenge-response

## Usage

```bash
cp .env.example .env     # add your NVIDIA_NIM_API_KEY
npm install
npm test                 # runs all 21 models
```

Dashboard at http://localhost:3457

## Requirements

- Docker (for agent containers)
- GitLab instance at gitlab.crux.casa (or change in skill.md)
- Game server at localhost:2567
- NVIDIA NIM API key

## Current best: 3/21 (14%)

Passing models: qwen3.5-397b, deepseek-v3.2, mistral-large-675b

See [experiments/log.md](experiments/log.md) for full history.
