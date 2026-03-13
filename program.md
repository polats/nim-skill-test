# nim-skill-test

This is an experiment to improve how well NIM-hosted LLMs follow a skill document autonomously.

## Setup

To set up a new experiment, work with the user to:

1. **Agree on a run tag**: propose a tag based on today's date (e.g. `mar13`). The branch `experiment/<tag>` must not already exist.
2. **Create the branch**: `git checkout -b experiment/<tag>` from current master.
3. **Read the in-scope files**: The repo is small. Read these files for full context:
   - `README.md` — repository context.
   - `program.md` — this file, your instructions.
   - `skill.md` — the file you modify. Instructions that 21 NIM models try to follow.
   - `src/run.ts` — the test runner. Do not modify unless necessary.
   - `src/models.json` — the 21 models being tested. Do not modify.
4. **Verify environment**: Check that `.env` has `NVIDIA_NIM_API_KEY`, Docker is running, GitLab is reachable at `gitlab.crux.casa`, and the game server is at `localhost:2567`.
5. **Initialize results.tsv**: Create `results.tsv` with just the header row. The baseline will be recorded after the first run.
6. **Confirm and go**: Confirm setup looks good.

Once you get confirmation, kick off the experimentation.

## Experimentation

Each experiment tests 21 NIM models (12B–1T parameters) on a 4-step task. Each model gets a fresh Ubuntu 24.04 Docker container with only `bash`, `curl`, `python3`, `ssh-keygen`, and `openssl`. Models must:

1. Register on GitLab (CSRF extraction + form POST)
2. Create a Personal Access Token
3. Generate SSH key + add to GitLab
4. Authenticate via SSH challenge-response

You launch an experiment simply as: `npx tsx src/run.ts --all > run.log 2>&1`

**What you CAN do:**
- Modify `skill.md` — this is the only file you edit. Everything is fair game: instruction wording, step ordering, code block structure, quoting style, variable names, helper scripts, etc.

**What you CANNOT do:**
- Modify `src/run.ts` or the test infrastructure (unless a bug prevents experiments from running).
- Change `src/models.json` — the model set is fixed.
- Modify the game server or GitLab — they are external dependencies.
- Add auto-registration, nudging, or any form of cheating. Models must follow `skill.md` independently.

**The goal is simple: get the highest pass_rate.** Since the model set and step budget (30 tool calls) are fixed, improvements come entirely from making `skill.md` clearer, simpler, and more robust for diverse LLMs.

## Output format

Once the run finishes it prints a summary like this:

```
---
pass_rate:    5/21
pass_count:   5
fail_count:   16
total_models: 21
run_id:       ab12
elapsed_sec:  847
model_result: pass qwen/qwen3.5-397b-a17b
model_result: pass deepseek-ai/deepseek-v3.2
model_result: fail meta/llama-3.1-70b-instruct
...
```

You can extract the key metric from the log file:

```bash
grep "^pass_rate:" run.log
```

## Logging results

When an experiment is done, log it to `results.tsv` (tab-separated).

The TSV has a header row and 5 columns:

```
commit	pass_rate	elapsed_sec	status	description
```

1. git commit hash (short, 7 chars)
2. pass_rate achieved (e.g. 3/21)
3. elapsed time in seconds
4. status: `keep`, `discard`, or `crash`
5. short text description of what this experiment tried

Example:

```
commit	pass_rate	elapsed_sec	status	description
a1b2c3d	3/21	847	keep	baseline
b2c3d4e	5/21	912	keep	write python scripts to files instead of inline
c3d4e5f	3/21	890	discard	use heredocs for script creation (models truncate them)
d4e5f6g	0/21	0	crash	syntax error in skill.md broke CSRF extraction
```

## The experiment loop

The experiment runs on a dedicated branch (e.g. `experiment/mar13`).

LOOP FOREVER:

1. Look at the git state and `results.tsv` to understand what has been tried and what worked.
2. Think about what to change in `skill.md`. Consider:
   - Which models are failing and why? Check `run.log` for error patterns.
   - Are models making tool calls? (0 tool calls = NIM API compat issue, not a skill.md problem)
   - Are models truncating commands? (shorten code blocks)
   - Are quoting/escaping issues breaking bash? (simplify quotes)
   - Are models skipping steps or going out of order? (make instructions more prescriptive)
   - Can you eliminate a common failure mode across multiple models?
3. Edit `skill.md` with an experimental idea.
4. `git add skill.md && git commit -m "description of change"`
5. Run the experiment: `npx tsx src/run.ts --all > run.log 2>&1`
6. Read out the results: `grep "^pass_rate:\|^elapsed_sec:\|^model_result:" run.log`
7. If grep output is empty, the run crashed. Run `tail -n 50 run.log` for the error. Fix and re-run.
8. Record the results in `results.tsv` (do NOT commit results.tsv — leave it untracked by git)
9. If pass_rate improved (higher pass count), KEEP the commit — you advance the branch.
10. If pass_rate is equal or worse, `git reset --hard HEAD~1` to discard the change.

## Analyzing failures

After each run, investigate failures:

```bash
# Which models passed/failed?
grep "^model_result:" run.log

# How many tool calls did each model make?
# (Check dashboard at http://localhost:3457 during the run)
```

Common failure patterns and fixes:
- **0 tool calls**: Model can't use OpenAI tool calling format via NIM. Skip these — not a skill.md problem.
- **Syntax errors in bash**: Model is collapsing multi-line to single-line. Make code blocks shorter or use simpler quoting.
- **`python3 -c` failures**: Embedded regex with quotes breaks when linearized. Write scripts to files first.
- **Heredoc truncation**: Models truncate `<< 'EOF'` blocks. Use `printf` or `echo` instead.
- **Variable scope loss**: Models forget that each tool call is a fresh shell. Make file-based state more obvious.
- **Steps skipped**: Model jumps ahead without completing earlier steps. Make dependencies explicit.

## Key constraints

- **RPM limit**: 38 requests/minute to NIM API. Each run takes ~15–20 minutes.
- **30 tool calls max**: Models that loop on errors exhaust their budget.
- **Docker cleanup**: Containers are auto-cleaned, but if something goes wrong: `docker ps -a --filter ancestor=ubuntu:24.04 -q | xargs -r docker rm -f`

## Simplicity criterion

All else being equal, simpler `skill.md` is better. A small improvement that adds complexity is not worth it. Removing instructions while maintaining pass_rate is a win. The ideal `skill.md` is the shortest document that gets the highest pass_rate.

## NEVER STOP

Once the experiment loop has begun, do NOT pause to ask the human if you should continue. Do NOT ask "should I keep going?" or "is this a good stopping point?". The human might be away and expects you to continue working indefinitely until manually stopped. You are autonomous. If you run out of ideas, analyze failure logs more deeply, try combining previous near-misses, or try more radical restructuring of `skill.md`.
