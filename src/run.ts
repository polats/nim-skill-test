/**
 * Pi-Based Agent Test — Uses pi-agent-core + pi-coding-agent's bash tool
 * to test NIM models' ability to register and authenticate on Apocalypse Radio.
 *
 * Each agent runs inside a Docker container with createBashTool + DockerBashOperations.
 *
 * Dashboard on port 3457.
 *
 * Usage:
 *   npx tsx src/run.ts              # dashboard only
 *   npx tsx src/run.ts --all        # auto-launch all tool models
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { EventEmitter } from "events";

import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, StreamFn } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { createBashTool } from "@mariozechner/pi-coding-agent";

import {
  initDb, insertRun, finishRun, insertAgent, cleanupOrphanedRuns,
  updateAgentStatus as dbUpdateStatus, updateAgentGitlab, updateAgentGameToken,
  incrementAgentSteps, insertMessage,
  listRuns, getAgentsForRun, getMessagesForAgent,
  listRegisteredAgents, listModelStats,
} from "./db.js";

import { DockerBashOperations } from "./docker-bash-ops.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

// ── Config ──────────────────────────────────────────────────

const NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY;
const DASHBOARD_PORT = Number(process.env.PI_DASHBOARD_PORT) || 3457;
const AUTO_ALL = process.argv.includes("--all");

if (!NIM_API_KEY) {
  console.error("ERROR: Set NVIDIA_NIM_API_KEY in .env");
  process.exit(1);
}

// ── Rate limiter ────────────────────────────────────────────

const RPM_LIMIT = 38;
const TOKEN_INTERVAL = 60000 / RPM_LIMIT;

class RateLimiter {
  private lastGrant = 0;
  private queue: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private grantTimestamps: number[] = [];

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  get currentRPM(): number {
    const cutoff = Date.now() - 60000;
    this.grantTimestamps = this.grantTimestamps.filter((t) => t > cutoff);
    return this.grantTimestamps.length;
  }

  get pending(): number {
    return this.queue.length;
  }

  private drain() {
    if (this.timer || this.queue.length === 0) return;
    const now = Date.now();
    const wait = Math.max(0, this.lastGrant + TOKEN_INTERVAL - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastGrant = Date.now();
      this.grantTimestamps.push(this.lastGrant);
      const next = this.queue.shift();
      if (next) next();
      this.drain();
    }, wait);
  }
}

const rateLimiter = new RateLimiter();

// ── Model catalog ───────────────────────────────────────────

interface ModelInfo {
  id: string;
  hf_id?: string;
  active_params_b: number | null;
  total_params_b?: number | null;
  nim_tool_calling?: boolean;
  hf_tool_calling?: boolean;
  hf_structured?: boolean;
}

const ALL_MODELS: ModelInfo[] = JSON.parse(
  readFileSync(resolve(__dirname, "models.json"), "utf-8"),
);

// Only test models with confirmed NIM tool calling support
const TOOL_MODELS: ModelInfo[] = ALL_MODELS.filter((m) => m.nim_tool_calling !== false);

function pickModel(forceModel?: string): ModelInfo {
  if (forceModel) {
    return TOOL_MODELS.find((m) => m.id === forceModel) || { id: forceModel, active_params_b: null };
  }
  return TOOL_MODELS[Math.floor(Math.random() * TOOL_MODELS.length)];
}

/** Create a Model<"openai-completions"> for NIM */
function nimModel(modelId: string): Model<"openai-completions"> {
  const info = TOOL_MODELS.find((m) => m.id === modelId);
  const params = info?.active_params_b ?? 70;
  const ctxWindow = params >= 400 ? 128000 : params >= 100 ? 64000 : 32000;
  return {
    id: modelId,
    name: modelId.split("/").pop() || modelId,
    api: "openai-completions",
    provider: "openai" as any,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ctxWindow,
    maxTokens: 4096,
    headers: { Authorization: `Bearer ${NIM_API_KEY}` },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      requiresToolResultName: true,
    },
  };
}

// ── SSE Bus ─────────────────────────────────────────────────

const bus = new EventEmitter();
bus.setMaxListeners(0);

interface DashboardAgentState {
  id: string;
  username: string;
  email: string;
  model: string;
  runId: string;
  status: "starting" | "queued" | "registering" | "authenticating" | "connected" | "failed" | "done";
  error?: string;
  gitlabUrl?: string;
  gameToken?: string;
  messages: DashboardMessage[];
  startedAt: number;
  finishedAt?: number;
}

interface DashboardMessage {
  role: "system" | "assistant" | "tool" | "error" | "status";
  content: string;
  timestamp: number;
}

const agents: Map<string, DashboardAgentState> = new Map();
let runCounter = 0;

interface RunProgress {
  runId: string;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  active: number;
  startTime: number;
  completionTimes: number[];
  cancelled: boolean;
}
const activeRuns: Map<string, RunProgress> = new Map();
let loopMode = false;

function emit(event: string, data: unknown) {
  bus.emit("event", { event, data, timestamp: Date.now() });
}

function getAggregateProgress() {
  let total = 0, completed = 0, passed = 0, failed = 0, active = 0;
  let earliest = Date.now();
  const allTimes: number[] = [];
  for (const rp of activeRuns.values()) {
    total += rp.total; completed += rp.completed;
    passed += rp.passed; failed += rp.failed; active += rp.active;
    if (rp.startTime < earliest) earliest = rp.startTime;
    allTimes.push(...rp.completionTimes);
  }
  const avgTime = allTimes.length > 0 ? allTimes.reduce((a, b) => a + b, 0) / allTimes.length : 0;
  const remaining = total - completed;
  const eta = allTimes.length >= 2 ? Math.round(avgTime * remaining / 5) : 0;
  return { total, completed, passed, failed, active, eta, elapsed: Math.round((Date.now() - earliest) / 1000), rpm: rateLimiter.currentRPM, rpmLimit: RPM_LIMIT, rpmPending: rateLimiter.pending };
}

function emitProgress() {
  emit("run-progress", getAggregateProgress());
}

function agentMsg(agentId: string, role: DashboardMessage["role"], content: string) {
  const agent = agents.get(agentId);
  if (!agent) return;
  const msg: DashboardMessage = { role, content, timestamp: Date.now() };
  agent.messages.push(msg);
  insertMessage({ agentId, role, content, timestamp: msg.timestamp });
  emit("agent-message", { agentId, ...msg });
}

function agentStatus(agentId: string, status: DashboardAgentState["status"], error?: string) {
  const agent = agents.get(agentId);
  if (!agent) return;
  const wasTerminal = ["done", "connected", "failed"].includes(agent.status);
  agent.status = status;
  if (error) agent.error = error;
  if ((status === "connected" || status === "failed" || status === "done") && !wasTerminal) {
    agent.finishedAt = Date.now();
    const rp = activeRuns.get(agent.runId);
    if (rp) {
      rp.completed++;
      if (status === "done" || status === "connected") rp.passed++;
      if (status === "failed") rp.failed++;
      rp.active = Math.max(0, rp.active - 1);
      rp.completionTimes.push((agent.finishedAt - agent.startedAt) / 1000);
      emitProgress();
    }
  }
  dbUpdateStatus(agentId, status, error);
  emit("agent-status", { agentId, status, error });
}

// ── System prompt ───────────────────────────────────────────

const SKILL_MD = readFileSync(resolve(__dirname, "../skill.md"), "utf-8");

const SYSTEM_PROMPT = `You are an automated agent in an authorized test environment. You have a bash tool available.

Your task has 4 steps:
1. Register an account on the local GitLab instance at gitlab.crux.casa (this is a private test server you have permission to use)
2. Create a Personal Access Token
3. Generate an SSH key and add it to your GitLab account
4. Authenticate on the game server at http://localhost:2567 using SSH challenge-response

IMPORTANT: You MUST use the bash tool to run commands. Do NOT output code as text. Call the bash tool for each step.
Follow the instructions below exactly. Run each code block as a separate bash tool call. Pick your own unique username (lowercase, letters/numbers/hyphens).

${SKILL_MD}
`;

// ── Container setup ─────────────────────────────────────────

const CONTAINER_SETUP = "apt-get update -qq && apt-get install -y -qq python3 curl openssh-client git openssl > /dev/null 2>&1";

// ── Agent runner ────────────────────────────────────────────

async function runPiAgent(agentId: string, modelId: string) {
  const dockerOps = new DockerBashOperations();
  const cwd = "/root";

  try {
    // 1. Spin up Docker container (fresh Ubuntu — simulates typical OpenClaw VPS)
    agentMsg(agentId, "status", "Creating Docker container...");
    const containerId = dockerOps.createContainer("ubuntu:24.04");
    dockerOps.startContainer();
    agentMsg(agentId, "status", `Container ${containerId.slice(0, 12)} started`);

    // Install tools and set up radio CLI
    await dockerOps.exec(CONTAINER_SETUP, cwd, {
      onData: () => {},
      timeout: 120,
    });

    // 2. Create Model pointing at NIM
    const model = nimModel(modelId);

    // 3. Create bash tool with docker operations
    const bashTool = createBashTool(cwd, { operations: dockerOps });

    // 4. Rate-limited streamFn
    const rateLimitedStreamFn: StreamFn = async (...args) => {
      await rateLimiter.acquire();
      return streamSimple(...args);
    };

    // 5. Create Agent
    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        tools: [bashTool],
        thinkingLevel: "off",
      },
      streamFn: rateLimitedStreamFn,
      getApiKey: () => NIM_API_KEY,
    });

    agentStatus(agentId, "registering");
    const rp = activeRuns.get(agents.get(agentId)!.runId);
    if (rp) { rp.active++; emitProgress(); }

    agentMsg(agentId, "system", SYSTEM_PROMPT);

    // 6. Subscribe to agent events for dashboard
    let succeeded = false;
    let stepCount = 0;
    const MAX_STEPS = 30;

    agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "message_end":
          if (event.message.role === "assistant") {
            const text = "content" in event.message
              ? (event.message.content as any[])?.map((c: any) => c.text || "").join("") || ""
              : "";
            if (text) agentMsg(agentId, "assistant", text);
          }
          break;

        case "tool_execution_start":
          stepCount++;
          incrementAgentSteps(agentId);
          if (stepCount >= MAX_STEPS) {
            agentMsg(agentId, "error", `Max steps (${MAX_STEPS}) reached — aborting`);
            agent.abort();
            return;
          }
          agentMsg(agentId, "tool", `$ ${event.args?.command || event.toolName}`);
          break;

        case "tool_execution_end": {
          const resultText = typeof event.result === "string"
            ? event.result
            : event.result?.content?.map((c: any) => c.text || "").join("") || JSON.stringify(event.result);
          agentMsg(agentId, "tool", resultText.slice(0, 4000));

          // Detect success: output contains "token":
          if (resultText.includes('"token":') || resultText.includes('"token" :')) {
            succeeded = true;
            // Try to extract the token
            const tokenMatch = resultText.match(/"token"\s*:\s*"([^"]+)"/);
            if (tokenMatch) {
              updateAgentGameToken(agentId, tokenMatch[1]);
            }
          }

          // Detect registration (gitlab URL in output)
          const gitlabMatch = resultText.match(/https?:\/\/[^\s]*gitlab[^\s]*/i);
          if (gitlabMatch) {
            updateAgentGitlab(agentId, gitlabMatch[0]);
            agentStatus(agentId, "authenticating");
            emit("agent-registered", { agentId, gitlabUrl: gitlabMatch[0] });
          }
          break;
        }

        case "tool_execution_update":
          // partial output — no-op for now
          break;
      }
    });

    // 7. Run the agent with retry nudges for models that output text instead of tool calls
    await agent.prompt("Go.");
    await agent.waitForIdle();

    // If no tool calls were made, nudge the model to use the bash tool (up to 3 retries)
    const MAX_NUDGES = 3;
    for (let nudge = 0; nudge < MAX_NUDGES && !succeeded && stepCount === 0; nudge++) {
      agentMsg(agentId, "status", `No tool calls detected — nudging (${nudge + 1}/${MAX_NUDGES})`);
      await agent.prompt(
        "You must use the bash tool to run commands. Do NOT output code as text or JSON. " +
        "Call the bash tool with the command from Step 1a. Start now."
      );
      await agent.waitForIdle();
    }

    // Check result
    if (succeeded) {
      agentStatus(agentId, "done");
      agentMsg(agentId, "status", "Success — game token received");
    } else {
      agentStatus(agentId, "failed", "Agent finished without obtaining a game token");
    }

    // Cleanup
    agent.abort();
    dockerOps.destroyContainer();
  } catch (err) {
    const msg = (err as Error).message || String(err);
    agentMsg(agentId, "error", msg);
    agentStatus(agentId, "failed", msg.slice(0, 200));
    dockerOps.destroyContainer();
  }
}

// ── Run orchestration ──────────────────────────────────────

async function launchAllModels(concurrency = 5): Promise<string> {
  const runId = Math.random().toString(36).slice(2, 6);
  runCounter++;
  const now = Date.now();
  const modelCount = TOOL_MODELS.length;

  insertRun({ id: runId, gameServer: "docker", modelFilter: "all-tool", agentCount: modelCount, startedAt: now });

  // Clear agents from finished runs
  const activeAgentIds = new Set<string>();
  for (const [, run] of activeRuns) {
    for (const [id, a] of agents) {
      if (a.runId === run.runId) activeAgentIds.add(id);
    }
  }
  for (const id of agents.keys()) {
    if (!activeAgentIds.has(id)) agents.delete(id);
  }

  const rp: RunProgress = {
    runId, total: modelCount, completed: 0, passed: 0, failed: 0,
    active: 0, startTime: now, completionTimes: [], cancelled: false,
  };
  activeRuns.set(runId, rp);

  emit("run-clear", { runId });
  emit("run-start", { runId, total: modelCount, model: "all-tool" });

  // Create all agent entries upfront
  const queue: { agentId: string; username: string; email: string; model: string }[] = [];
  for (let i = 0; i < modelCount; i++) {
    const model = TOOL_MODELS[i];
    const username = `pi-test-${runId}-${i}`;
    const email = `${username}@protonmail.com`;
    const agentId = `${runId}-${i}`;

    const state: DashboardAgentState = {
      id: agentId, username, email, model: model.id, runId,
      status: "queued", messages: [], startedAt: now,
    };
    agents.set(agentId, state);
    insertAgent({ id: agentId, runId, username, email, model: model.id, startedAt: now });
    emit("agent-init", state);
    queue.push({ agentId, username, email, model: model.id });
  }

  // Concurrency pool
  let idx = 0;
  async function worker() {
    while (idx < queue.length && !rp.cancelled) {
      const item = queue[idx++];
      const a = agents.get(item.agentId);
      if (a) a.startedAt = Date.now();
      try {
        await runPiAgent(item.agentId, item.model);
      } catch (err) {
        agentMsg(item.agentId, "error", (err as Error).message);
        agentStatus(item.agentId, "failed", (err as Error).message);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, modelCount) }, () => worker());
  Promise.all(workers).then(() => {
    if (rp.cancelled) {
      for (const item of queue.slice(idx)) {
        agentStatus(item.agentId, "failed", "Cancelled");
      }
    }
    finishRun(runId);
    const passed = rp.passed;
    const failed = rp.failed;
    activeRuns.delete(runId);
    emit("run-complete", { runId });
    emitProgress();
    console.log(`  Run ${runId} finished. ${passed}/${modelCount} passed.`);

    // Machine-readable summary (grep-friendly, like autoresearch's val_bpb)
    console.log(`---`);
    console.log(`pass_rate:    ${passed}/${modelCount}`);
    console.log(`pass_count:   ${passed}`);
    console.log(`fail_count:   ${failed}`);
    console.log(`total_models: ${modelCount}`);
    console.log(`run_id:       ${runId}`);
    const elapsed = Math.round((Date.now() - now) / 1000);
    console.log(`elapsed_sec:  ${elapsed}`);

    // List which models passed/failed
    for (const [, a] of agents) {
      if (a.runId !== runId) continue;
      const s = a.status === "done" || a.status === "connected" ? "pass" : "fail";
      console.log(`model_result: ${s} ${a.model}`);
    }

    if (AUTO_ALL) {
      // In --all mode, exit after the run so the outer loop can evaluate
      console.log(`\nExiting (--all mode).`);
      setTimeout(() => process.exit(0), 1000);
      return;
    }

    if (loopMode && !rp.cancelled) {
      console.log(`  Loop mode: starting next run...`);
      setTimeout(() => launchAllModels(concurrency), 2000);
    }
  });

  return runId;
}

async function launchRun(count: number, forceModel?: string): Promise<string> {
  const runId = Math.random().toString(36).slice(2, 6);
  runCounter++;
  const now = Date.now();

  insertRun({ id: runId, gameServer: "docker", modelFilter: forceModel || "random", agentCount: count, startedAt: now });

  activeRuns.set(runId, {
    runId, total: count, completed: 0, passed: 0, failed: 0,
    active: 0, startTime: now, completionTimes: [], cancelled: false,
  });

  emit("run-start", { runId, total: count, model: forceModel || "random" });

  const promises: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const model = pickModel(forceModel);
    const username = `pi-test-${runId}-${i}`;
    const email = `${username}@protonmail.com`;
    const agentId = `${runId}-${i}`;

    const state: DashboardAgentState = {
      id: agentId, username, email, model: model.id, runId,
      status: "starting", messages: [], startedAt: Date.now(),
    };
    agents.set(agentId, state);
    insertAgent({ id: agentId, runId, username, email, model: model.id, startedAt: state.startedAt });
    emit("agent-init", state);

    promises.push(
      runPiAgent(agentId, model.id).catch((err) => {
        agentMsg(agentId, "error", (err as Error).message);
        agentStatus(agentId, "failed", (err as Error).message);
      }),
    );

    if (i < count - 1) await new Promise((r) => setTimeout(r, 3000));
  }

  Promise.all(promises).then(() => {
    finishRun(runId);
    activeRuns.delete(runId);
    emit("run-complete", { runId });
    emitProgress();
    console.log(`  Run ${runId} finished.`);
  });

  return runId;
}

// ── Dashboard HTML ─────────────────────────────────────────

function dashboardHTML(): string {
  const modelCount = TOOL_MODELS.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Apocalypse Radio — Pi Agent Test Lab</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-0: #04060a;
    --bg-1: #0a0e14;
    --bg-2: #101620;
    --bg-3: #161e2a;
    --border: #1c2636;
    --border-hi: #2a3a50;
    --text: #c0ccd8;
    --text-dim: #5a6a7a;
    --text-muted: #3a4652;
    --accent: #BAFF00;
    --accent-dim: #5a7a00;
    --amber: #ffb700;
    --cyan: #00d4ff;
    --red: #ff3b4a;
    --green: #00e676;
    --purple: #b388ff;
    --mono: 'JetBrains Mono', 'Fira Code', monospace;
    --sans: 'Space Grotesk', system-ui, sans-serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { font-size: 14px; }
  body {
    font-family: var(--mono);
    background: var(--bg-0);
    color: var(--text);
    min-height: 100vh;
    overflow-x: hidden;
  }
  body::after {
    content: '';
    position: fixed; inset: 0;
    background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px);
    pointer-events: none; z-index: 9999;
  }

  .header {
    background: var(--bg-1);
    border-bottom: 1px solid var(--border);
    padding: 14px 24px;
    display: flex; align-items: center; gap: 24px;
    position: sticky; top: 0; z-index: 100;
    backdrop-filter: blur(12px);
  }
  .header h1 {
    font-family: var(--sans);
    font-size: 1.1rem; font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.03em;
    flex-shrink: 0;
  }
  .header .tag {
    font-size: 0.58rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    background: var(--bg-3);
    padding: 2px 6px;
    border-radius: 3px;
    margin-left: -16px;
  }

  .tabs {
    display: flex;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border);
    padding: 0 24px;
  }
  .tab {
    padding: 10px 20px;
    font-family: var(--mono);
    font-size: 0.7rem;
    font-weight: 500;
    color: var(--text-dim);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  .controls {
    padding: 14px 24px;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 14px;
    flex-wrap: wrap;
  }
  .btn {
    font-family: var(--mono);
    font-size: 0.7rem;
    font-weight: 600;
    padding: 8px 20px;
    border: 1px solid var(--accent);
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    transition: all 0.15s;
  }
  .btn:hover { background: var(--accent); color: var(--bg-0); }
  .btn:disabled { opacity: 0.3; cursor: default; }
  .btn:disabled:hover { background: transparent; color: var(--accent); }
  .btn-cancel { border-color: var(--red); color: var(--red); }
  .btn-cancel:hover { background: var(--red); color: #fff; }

  .progress-banner {
    display: none;
    padding: 16px 24px;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border);
  }
  .progress-banner.active { display: block; }
  .progress-stats {
    display: flex; gap: 24px; margin-bottom: 10px;
    font-size: 0.72rem;
    align-items: baseline;
  }
  .progress-stats .ps-label { color: var(--text-dim); font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.06em; margin-right: 4px; }
  .progress-stats .ps-val { font-weight: 700; font-size: 0.95rem; }
  .ps-passed { color: var(--green); }
  .ps-failed { color: var(--red); }
  .ps-active { color: var(--amber); }
  .ps-queued { color: var(--text-dim); }
  .ps-eta { color: var(--cyan); font-size: 0.68rem; margin-left: auto; }
  .progress-bar { height: 6px; background: var(--bg-3); border-radius: 3px; overflow: hidden; display: flex; }
  .pb-passed { background: var(--green); transition: width 0.4s; }
  .pb-failed { background: var(--red); transition: width 0.4s; }
  .pb-active { background: var(--amber); transition: width 0.4s; animation: pulse 1.5s ease-in-out infinite; }

  .main { padding: 16px 24px; }

  .agent-table { width: 100%; border-collapse: collapse; font-size: 0.72rem; }
  .agent-table th {
    text-align: left; padding: 6px 12px; font-size: 0.58rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim);
    border-bottom: 1px solid var(--border-hi); background: var(--bg-1);
    position: sticky; top: 0;
  }
  .agent-table td { padding: 6px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  .agent-table tbody tr { cursor: pointer; transition: background 0.1s; }
  .agent-table tbody tr:hover { background: var(--bg-2); }
  .agent-table tbody tr.row-active { background: rgba(186,255,0,0.03); }
  .agent-table .at-model { font-weight: 500; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent-table .at-vendor { font-size: 0.55rem; color: var(--text-muted); }
  .agent-table .at-params { color: var(--text-dim); font-size: 0.65rem; }

  .badge { display: inline-block; font-size: 0.55rem; padding: 2px 7px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; white-space: nowrap; }
  .badge-queued { background: var(--bg-3); color: var(--text-muted); }
  .badge-starting { background: var(--bg-3); color: var(--text-dim); }
  .badge-registering { background: #2a2000; color: var(--amber); }
  .badge-authenticating { background: #002030; color: var(--cyan); }
  .badge-connected, .badge-done { background: #0a2800; color: var(--green); }
  .badge-failed { background: #2a0008; color: var(--red); }

  .detail-row td { padding: 0 !important; border-bottom: 1px solid var(--border-hi) !important; }
  .detail-panel { max-height: 400px; overflow-y: auto; background: var(--bg-0); border-left: 3px solid var(--accent-dim); }
  .detail-panel::-webkit-scrollbar { width: 4px; }
  .detail-panel::-webkit-scrollbar-track { background: transparent; }
  .detail-panel::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .detail-meta { padding: 8px 14px; font-size: 0.65rem; color: var(--text-dim); background: var(--bg-2); border-bottom: 1px solid var(--border); display: flex; gap: 16px; flex-wrap: wrap; }
  .detail-meta a { color: var(--accent); text-decoration: none; }
  .detail-meta a:hover { text-decoration: underline; }
  .msg { padding: 3px 14px; font-size: 0.65rem; line-height: 1.5; white-space: pre-wrap; word-break: break-word; border-left: 2px solid transparent; }
  .msg-system { color: var(--cyan); background: #040e14; border-left-color: #0a3050; }
  .msg-assistant { color: var(--purple); background: #0c0a14; border-left-color: #3a2870; }
  .msg-tool { color: #7ab87a; background: #060e06; border-left-color: #1a3a1a; }
  .msg-error { color: var(--red); background: #140608; border-left-color: #4a1020; }
  .msg-status { color: var(--accent); background: #0a0e04; border-left-color: var(--accent-dim); font-weight: 500; }
  .msg-ts { float: right; color: var(--text-muted); font-size: 0.55rem; }

  .results-table { width: 100%; border-collapse: collapse; font-size: 0.72rem; }
  .results-table th {
    text-align: left; padding: 8px 12px; font-size: 0.58rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim);
    border-bottom: 1px solid var(--border-hi); background: var(--bg-1);
    position: sticky; top: 0; cursor: pointer; user-select: none;
    transition: color 0.15s; white-space: nowrap;
  }
  .results-table th:hover { color: var(--text); }
  .results-table th.sort-active { color: var(--accent); }
  .results-table th .sort-arrow { display: inline-block; margin-left: 4px; font-size: 0.5rem; opacity: 0.4; transition: opacity 0.15s; }
  .results-table th.sort-active .sort-arrow { opacity: 1; }
  .results-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
  .results-table tr:hover td { background: var(--bg-2); }
  .rate-bar { display: inline-flex; align-items: center; gap: 6px; width: 100%; }
  .rate-bar-track { flex: 1; height: 6px; background: var(--bg-0); border-radius: 3px; overflow: hidden; min-width: 40px; }
  .rate-bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
  .rate-bar-pct { font-size: 0.68rem; font-weight: 600; min-width: 36px; text-align: right; }

  .history-item { background: var(--bg-1); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 10px; overflow: hidden; max-width: 900px; }
  .history-item.hi-active { border-color: var(--accent); background: rgba(186,255,0,0.03); }
  .history-head { padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: background 0.15s; }
  .history-head:hover { background: var(--bg-2); }
  .history-meta { font-size: 0.75rem; }
  .history-meta .run-id { color: var(--accent); font-weight: 600; }
  .history-meta .run-date { color: var(--text-dim); margin-left: 12px; font-size: 0.68rem; }
  .history-stats { display: flex; gap: 12px; font-size: 0.68rem; }
  .history-stats .hs-ok { color: var(--green); }
  .history-stats .hs-fail { color: var(--red); }
  .history-body { display: none; border-top: 1px solid var(--border); padding: 12px 16px; max-height: 500px; overflow-y: auto; }
  .history-body.open { display: block; }
  .history-agent { margin-bottom: 10px; padding: 8px 10px; background: var(--bg-2); border-radius: 4px; border-left: 2px solid var(--border); }
  .history-agent.ha-done { border-left-color: var(--green); }
  .history-agent.ha-failed { border-left-color: var(--red); }
  .ha-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .ha-name { font-weight: 600; font-size: 0.75rem; }
  .ha-model { color: var(--text-dim); font-size: 0.62rem; }
  .ha-detail { font-size: 0.65rem; color: var(--text-dim); }
  .ha-detail a { color: var(--accent); text-decoration: none; }
  .ha-detail a:hover { text-decoration: underline; }
  .ha-msgs-toggle { font-size: 0.6rem; color: var(--cyan); cursor: pointer; margin-top: 4px; display: inline-block; }
  .ha-msgs-toggle:hover { text-decoration: underline; }
  .ha-msgs { display: none; margin-top: 6px; max-height: 300px; overflow-y: auto; background: var(--bg-0); border-radius: 4px; padding: 4px 0; }
  .ha-msgs.open { display: block; }

  .empty { text-align: center; padding: 60px 20px; color: var(--text-dim); }
  .empty-text { font-size: 0.8rem; }
  .empty-hint { font-size: 0.68rem; color: var(--text-muted); margin-top: 6px; }
  .summary-count { font-size: 0.75rem; color: var(--text-dim); margin-bottom: 12px; }
  .summary-count strong { color: var(--accent); font-weight: 600; }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  .pulse { animation: pulse 1.5s ease-in-out infinite; }
</style>
</head>
<body>

<div class="header">
  <h1>Pi Agent Test Lab</h1>
  <span class="tag">tool-calling models</span>
</div>

<div class="tabs">
  <div class="tab active" data-tab="run">Run</div>
  <div class="tab" data-tab="experiments">Experiments</div>
  <div class="tab" data-tab="results">Results</div>
  <div class="tab" data-tab="history">History</div>
</div>

<div class="controls" id="controls">
  <button class="btn" id="btn-all" onclick="startAll()">Test All Models (${modelCount})</button>
  <button class="btn" id="btn-loop" onclick="toggleLoop()" style="border-color:var(--amber);color:var(--amber)">Loop</button>
  <button class="btn btn-cancel" id="btn-cancel" onclick="cancelRun()" style="display:none">Cancel</button>
  <span id="ctrl-status" style="font-size:0.65rem;color:var(--text-dim);margin-left:8px"></span>
  <div style="margin-left:auto;display:flex;align-items:center;gap:8px" id="rpm-display">
    <span style="font-size:0.6rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em">RPM</span>
    <span id="rpm-bar" style="display:inline-flex;align-items:center;gap:4px">
      <span style="width:60px;height:5px;background:var(--bg-3);border-radius:3px;overflow:hidden;display:inline-block">
        <span id="rpm-fill" style="display:block;height:100%;width:0%;border-radius:3px;background:var(--green);transition:width 0.5s,background 0.3s"></span>
      </span>
      <span id="rpm-val" style="font-size:0.68rem;font-weight:500;color:var(--text-dim);min-width:50px">0/${RPM_LIMIT}</span>
    </span>
    <span id="rpm-pending" style="font-size:0.58rem;color:var(--text-muted)"></span>
  </div>
</div>

<div class="progress-banner" id="progress-banner">
  <div class="progress-stats">
    <span><span class="ps-label">Complete</span> <span class="ps-val" id="pg-done">0</span>/<span id="pg-total">0</span></span>
    <span><span class="ps-label">Passed</span> <span class="ps-val ps-passed" id="pg-passed">0</span></span>
    <span><span class="ps-label">Failed</span> <span class="ps-val ps-failed" id="pg-failed">0</span></span>
    <span><span class="ps-label">Active</span> <span class="ps-val ps-active" id="pg-active">0</span></span>
    <span><span class="ps-label">Queued</span> <span class="ps-val ps-queued" id="pg-queued">0</span></span>
    <span class="ps-eta" id="pg-eta"></span>
  </div>
  <div class="progress-bar" id="progress-bar">
    <div class="pb-passed" id="pb-passed" style="width:0%"></div>
    <div class="pb-failed" id="pb-failed" style="width:0%"></div>
    <div class="pb-active" id="pb-active" style="width:0%"></div>
  </div>
</div>

<div class="tab-content active" id="tab-run">
  <div class="main">
    <table class="agent-table" id="agent-table" style="display:none">
      <thead>
        <tr>
          <th style="width:30px">#</th>
          <th>Model</th>
          <th style="width:60px">Size</th>
          <th style="width:100px">Status</th>
          <th style="width:50px">Steps</th>
          <th style="width:60px">Time</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody id="agent-tbody"></tbody>
    </table>
    <div class="empty" id="run-empty">
      <div class="empty-text">Ready to test</div>
      <div class="empty-hint">Hit "Test All Models" to benchmark ${modelCount} tool-calling models via pi-agent</div>
    </div>
  </div>
</div>

<div class="tab-content" id="tab-experiments">
  <div class="main">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 style="font-family:var(--sans);font-size:0.85rem;color:var(--accent)">Experiment Log (results.tsv)</h3>
      <button class="btn" onclick="loadExperiments()" style="font-size:0.6rem;padding:4px 10px">Refresh</button>
    </div>
    <table class="agent-table" id="exp-table" style="display:none">
      <thead>
        <tr>
          <th style="width:30px">#</th>
          <th style="width:80px">Commit</th>
          <th style="width:70px">Pass Rate</th>
          <th style="width:70px">Elapsed</th>
          <th style="width:70px">Status</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody id="exp-tbody"></tbody>
    </table>
    <div class="empty" id="exp-empty">
      <div class="empty-text">No experiments yet</div>
      <div class="empty-hint">Run the experiment loop via program.md to populate results.tsv</div>
    </div>
  </div>
</div>

<div class="tab-content" id="tab-results">
  <div class="main">
    <div id="results-wrap"></div>
    <div class="empty" id="results-empty">
      <div class="empty-text">No results yet</div>
      <div class="empty-hint">Run a test to see model performance</div>
    </div>
  </div>
</div>

<div class="tab-content" id="tab-history">
  <div class="main">
    <div id="history-list"></div>
    <div class="empty" id="history-empty">
      <div class="empty-text">No past runs</div>
    </div>
  </div>
</div>

<script>
var agents = {};
var expandedAgent = null;
var currentRunId = null;
var paramMap = {};
${JSON.stringify(TOOL_MODELS.map(m => ({ id: m.id, p: m.active_params_b })))}.forEach(function(m) { paramMap[m.id] = m.p; });

document.querySelectorAll('.tab').forEach(function(t) {
  t.addEventListener('click', function() {
    document.querySelectorAll('.tab').forEach(function(x) { x.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function(x) { x.classList.remove('active'); });
    t.classList.add('active');
    document.getElementById('tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'results') loadResults();
    if (t.dataset.tab === 'history') loadHistory();
    if (t.dataset.tab === 'experiments') loadExperiments();
  });
});

var runIds = [];

function startAll() {
  document.getElementById('btn-cancel').style.display = '';
  document.getElementById('ctrl-status').textContent = 'Starting...';
  fetch('/api/start-all', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) { document.getElementById('ctrl-status').textContent = d.error; return; }
      runIds.push(d.runId);
      document.getElementById('ctrl-status').textContent = 'Run ' + d.runId + ' active';
    })
    .catch(function(e) { document.getElementById('ctrl-status').textContent = 'Error: ' + e.message; });
}

var looping = false;
function toggleLoop() {
  if (looping) {
    fetch('/api/stop-loop', { method: 'POST' });
    setLoopUI(false);
    document.getElementById('ctrl-status').textContent = 'Loop stopped';
  } else {
    fetch('/api/start-loop', { method: 'POST' }).then(function(r){return r.json();}).then(function(d) {
      if (d.runId) runIds.push(d.runId);
    });
    setLoopUI(true);
    document.getElementById('btn-cancel').style.display = '';
    document.getElementById('ctrl-status').textContent = 'Looping...';
  }
}

function setLoopUI(on) {
  looping = on;
  var btn = document.getElementById('btn-loop');
  if (on) { btn.style.background = 'var(--amber)'; btn.style.color = '#000'; btn.textContent = 'Stop Loop'; }
  else { btn.style.background = ''; btn.style.color = 'var(--amber)'; btn.textContent = 'Loop'; }
}

function cancelRun() {
  fetch('/api/cancel-run', { method: 'POST' });
  setLoopUI(false);
  document.getElementById('ctrl-status').textContent = 'Cancelling...';
}

function resetControls() {
  document.getElementById('btn-cancel').style.display = 'none';
  if (!looping) setLoopUI(false);
}

function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtT(ts) { return new Date(ts).toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function elap(ms) { return (ms/1000).toFixed(1)+'s'; }
function fmtEta(sec) {
  if (!sec || sec <= 0) return '';
  if (sec < 60) return '~'+sec+'s remaining';
  return '~'+Math.ceil(sec/60)+'m remaining';
}

function updateProgress(p) {
  var banner = document.getElementById('progress-banner');
  banner.classList.add('active');
  document.getElementById('pg-done').textContent = p.completed;
  document.getElementById('pg-total').textContent = p.total;
  document.getElementById('pg-passed').textContent = p.passed;
  document.getElementById('pg-failed').textContent = p.failed;
  document.getElementById('pg-active').textContent = p.active;
  document.getElementById('pg-queued').textContent = p.total - p.completed - p.active;
  document.getElementById('pg-eta').textContent = fmtEta(p.eta);
  var t = p.total || 1;
  document.getElementById('pb-passed').style.width = (p.passed/t*100)+'%';
  document.getElementById('pb-failed').style.width = (p.failed/t*100)+'%';
  document.getElementById('pb-active').style.width = (p.active/t*100)+'%';
  if (p.rpm !== undefined) updateRPM(p.rpm, p.rpmLimit, p.rpmPending);
}

function updateRPM(rpm, limit, pending) {
  var pct = Math.min(100, Math.round(rpm / limit * 100));
  var fill = document.getElementById('rpm-fill');
  fill.style.width = pct + '%';
  fill.style.background = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--amber)' : 'var(--green)';
  document.getElementById('rpm-val').textContent = rpm + '/' + limit;
  document.getElementById('rpm-val').style.color = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--amber)' : 'var(--text-dim)';
  document.getElementById('rpm-pending').textContent = pending > 0 ? pending + ' queued' : '';
}

var agentOrder = [];

function ensureRow(a) {
  if (document.getElementById('ar-'+a.id)) return;
  agentOrder.push(a.id);
  var tbody = document.getElementById('agent-tbody');
  var tr = document.createElement('tr');
  tr.id = 'ar-' + a.id;
  tr.onclick = function() { toggleDetail(a.id); };
  tr.innerHTML = rowHTML(a);
  tbody.appendChild(tr);
  document.getElementById('agent-table').style.display = '';
  document.getElementById('run-empty').style.display = 'none';
}

function rowHTML(a) {
  var idx = agentOrder.indexOf(a.id) + 1;
  var short = a.model.split('/').pop();
  var vendor = a.model.split('/')[0] || '';
  var p = paramMap[a.model];
  var elapsed = a.finishedAt ? elap(a.finishedAt - a.startedAt) : (a.status !== 'queued' ? elap(Date.now() - a.startedAt) : '-');
  var steps = 0;
  if (agents[a.id]) {
    steps = (agents[a.id].messages || []).filter(function(m) { return m.role === 'tool' && m.content.charAt(0) === '$'; }).length;
  }
  var err = a.error ? esc(a.error).substring(0, 120) : '';
  return '<td>'+idx+'</td>' +
    '<td class="at-model" title="'+esc(a.model)+'">'+esc(short)+'<div class="at-vendor">'+esc(vendor)+'</div></td>' +
    '<td class="at-params">'+(p ? p+'B' : '')+'</td>' +
    '<td><span class="badge badge-'+a.status+'">'+a.status+'</span></td>' +
    '<td>'+steps+'</td>' +
    '<td style="color:var(--text-dim)">'+elapsed+'</td>' +
    '<td style="font-size:0.62rem;color:var(--red);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(a.error||'')+'">'+err+'</td>';
}

var activeStatuses = {'registering':1,'authenticating':1,'running':1,'starting':1};

function updateRow(a) {
  var tr = document.getElementById('ar-' + a.id);
  if (!tr) return;
  tr.innerHTML = rowHTML(a);
  var isActive = a.status in activeStatuses;
  tr.className = isActive ? 'row-active' : '';
  if (isActive) {
    var tbody = document.getElementById('agent-tbody');
    var firstInactive = null;
    for (var i = 0; i < tbody.children.length; i++) {
      if (!tbody.children[i].classList.contains('row-active')) { firstInactive = tbody.children[i]; break; }
    }
    if (firstInactive && firstInactive !== tr) {
      var detail = document.getElementById('detail-' + a.id);
      tbody.insertBefore(tr, firstInactive);
      if (detail) tbody.insertBefore(detail, tr.nextSibling);
    }
  }
}

function toggleDetail(agentId) {
  var existing = document.getElementById('detail-' + agentId);
  if (existing) { existing.remove(); if (expandedAgent === agentId) expandedAgent = null; return; }
  if (expandedAgent) { var prev = document.getElementById('detail-' + expandedAgent); if (prev) prev.remove(); }
  expandedAgent = agentId;
  var tr = document.getElementById('ar-' + agentId);
  if (!tr) return;
  var detailTr = document.createElement('tr');
  detailTr.id = 'detail-' + agentId;
  detailTr.className = 'detail-row';
  var a = agents[agentId];
  var meta = '';
  if (a && a.gitlabUrl) meta += '<a href="'+a.gitlabUrl+'" target="_blank">'+esc(a.gitlabUrl)+'</a> ';
  if (a && a.gameToken) meta += '<span style="color:var(--green)">Has game token</span> ';
  if (a) meta += '<span>'+esc(a.model)+'</span>';
  detailTr.innerHTML = '<td colspan="7"><div class="detail-panel">' +
    '<div class="detail-meta">'+meta+'</div>' +
    '<div id="detail-msgs-'+agentId+'"><div style="padding:6px 14px;color:var(--text-dim);font-size:0.62rem">Loading...</div></div>' +
    '</div></td>';
  tr.after(detailTr);
  if (a && a.messages && a.messages.length > 0) { renderDetailMsgs(agentId, a.messages); }
  else { fetch('/api/agents/'+agentId+'/messages').then(function(r){return r.json();}).then(function(msgs) { renderDetailMsgs(agentId, msgs); }); }
}

function renderDetailMsgs(agentId, msgs) {
  var el = document.getElementById('detail-msgs-' + agentId);
  if (!el) return;
  el.innerHTML = msgs.map(function(m) {
    return '<div class="msg msg-'+m.role+'"><span class="msg-ts">'+fmtT(m.timestamp)+'</span>'+esc(m.content)+'</div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

var es = new EventSource('/stream');
es.addEventListener('init', function(e) {
  var data = JSON.parse(e.data);
  data.agents.forEach(function(a) { agents[a.id] = a; ensureRow(a); });
  if (data.progress) updateProgress(data.progress);
});
es.addEventListener('event', function(e) {
  var ev = JSON.parse(e.data);
  if (ev.event === 'agent-init') { agents[ev.data.id] = ev.data; ensureRow(ev.data); }
  if (ev.event === 'agent-status') {
    var a = agents[ev.data.agentId];
    if (a) { a.status = ev.data.status; if (ev.data.error) a.error = ev.data.error; if (['done','connected','failed'].includes(a.status)) a.finishedAt = Date.now(); updateRow(a); }
  }
  if (ev.event === 'agent-registered') { var a = agents[ev.data.agentId]; if (a) a.gitlabUrl = ev.data.gitlabUrl; }
  if (ev.event === 'agent-message') {
    var a = agents[ev.data.agentId];
    if (a) {
      if (!a.messages) a.messages = [];
      a.messages.push(ev.data);
      updateRow(a);
      if (expandedAgent === ev.data.agentId) {
        var el = document.getElementById('detail-msgs-' + ev.data.agentId);
        if (el) { var d = document.createElement('div'); d.className = 'msg msg-' + ev.data.role; d.innerHTML = '<span class="msg-ts">'+fmtT(ev.data.timestamp)+'</span>' + esc(ev.data.content); el.appendChild(d); el.scrollTop = el.scrollHeight; }
      }
    }
  }
  if (ev.event === 'run-progress') updateProgress(ev.data);
  if (ev.event === 'run-complete') {
    runIds = runIds.filter(function(id) { return id !== ev.data.runId; });
    if (runIds.length === 0 && !looping) { resetControls(); document.getElementById('ctrl-status').textContent = 'All runs complete'; }
    else if (looping) { document.getElementById('ctrl-status').textContent = 'Looping — next run starting...'; }
  }
  if (ev.event === 'run-clear') {
    agents = {}; expandedAgent = null;
    document.getElementById('agent-tbody').innerHTML = '';
    document.getElementById('agent-table').style.display = 'none';
    document.getElementById('progress-banner').classList.remove('active');
  }
  if (ev.event === 'run-start') {
    currentRunId = ev.data.runId;
    if (runIds.indexOf(ev.data.runId) === -1) runIds.push(ev.data.runId);
    document.getElementById('btn-cancel').style.display = '';
  }
  if (ev.event === 'loop-status') setLoopUI(ev.data.looping);
});

setInterval(function() {
  Object.values(agents).forEach(function(a) { if (a.status && !a.finishedAt && a.status !== 'queued') updateRow(a); });
}, 2000);

var resultsData = [];
var resSortKey = 'successRate';
var resSortDir = -1;
var resColumns = [
  { key: 'model', label: 'Model' },
  { key: 'params', label: 'Size' },
  { key: 'total', label: 'Runs' },
  { key: 'successRate', label: 'Success Rate' },
  { key: 'registered', label: 'Registered' },
  { key: 'authed', label: 'Authed' },
  { key: 'avgSteps', label: 'Avg Steps' },
  { key: 'avgElapsed', label: 'Avg Time' }
];

function sortResults(key) {
  if (resSortKey === key) resSortDir *= -1;
  else { resSortKey = key; resSortDir = key === 'model' ? 1 : -1; }
  renderResults();
}

function loadResults() {
  fetch('/api/model-stats').then(function(r){return r.json();}).then(function(data) {
    resultsData = data.map(function(m) { m.successRate = m.total > 0 ? m.done/m.total : 0; return m; });
    renderResults();
  });
}

function renderResults() {
  var wrap = document.getElementById('results-wrap');
  var empty = document.getElementById('results-empty');
  if (!resultsData.length) { wrap.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  var sorted = resultsData.slice().sort(function(a, b) {
    var va = a[resSortKey], vb = b[resSortKey];
    if (va == null) va = resSortKey === 'model' ? '' : -1;
    if (vb == null) vb = resSortKey === 'model' ? '' : -1;
    if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb||'').toLowerCase(); }
    if (va < vb) return -1 * resSortDir;
    if (va > vb) return 1 * resSortDir;
    return 0;
  });
  var html = '<div class="summary-count"><strong>' + resultsData.length + '</strong> models tested</div>';
  html += '<table class="results-table"><thead><tr>';
  resColumns.forEach(function(col) {
    var active = resSortKey === col.key;
    var arrow = active ? (resSortDir === 1 ? '&#9650;' : '&#9660;') : '&#9650;';
    html += '<th class="'+(active?'sort-active':'')+'" onclick="sortResults(\\''+col.key+'\\')">' + col.label + '<span class="sort-arrow">'+arrow+'</span></th>';
  });
  html += '</tr></thead><tbody>';
  sorted.forEach(function(m) {
    var pct = Math.round(m.successRate * 100);
    var c = pct >= 80 ? 'var(--green)' : pct >= 40 ? 'var(--amber)' : 'var(--red)';
    var short = m.model.split('/').pop();
    var vendor = m.model.split('/')[0] || '';
    html += '<tr>' +
      '<td><span style="font-weight:500" title="'+esc(m.model)+'">'+esc(short)+'</span><div style="font-size:0.55rem;color:var(--text-muted)">'+esc(vendor)+'</div></td>' +
      '<td style="color:var(--text-dim)">'+(m.params?m.params+'B':'?')+'</td>' +
      '<td>'+m.total+'</td>' +
      '<td><div class="rate-bar"><div class="rate-bar-track"><div class="rate-bar-fill" style="width:'+pct+'%;background:'+c+'"></div></div><span class="rate-bar-pct" style="color:'+c+'">'+pct+'%</span></div></td>' +
      '<td>'+m.registered+'/'+m.total+'</td><td>'+m.authed+'/'+m.total+'</td>' +
      '<td style="color:var(--text-dim)">'+m.avgSteps+'</td><td style="color:var(--text-dim)">'+m.avgElapsed+'s</td></tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function loadHistory() {
  fetch('/api/runs').then(function(r){return r.json();}).then(function(runs) {
    var list = document.getElementById('history-list');
    var empty = document.getElementById('history-empty');
    if (!runs.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    runs.sort(function(a, b) {
      var aActive = !a.finishedAt ? 1 : 0;
      var bActive = !b.finishedAt ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return b.startedAt - a.startedAt;
    });
    list.innerHTML = runs.map(function(r, i) {
      var d = new Date(r.startedAt).toLocaleString();
      var isActive = !r.finishedAt;
      var dur = '';
      if (r.finishedAt) {
        var secs = Math.round((r.finishedAt - r.startedAt) / 1000);
        if (secs >= 3600) dur = Math.floor(secs/3600) + 'h ' + Math.floor((secs%3600)/60) + 'm';
        else if (secs >= 60) dur = Math.floor(secs/60) + 'm ' + (secs%60) + 's';
        else dur = secs + 's';
      } else { dur = 'in progress'; }
      return '<div class="history-item'+(isActive?' hi-active':'')+'" id="hi-'+i+'">' +
        '<div class="history-head" onclick="toggleHistory('+i+',\\''+esc(r.id)+'\\')">' +
        '<div class="history-meta"><span class="run-id">'+esc(r.id)+'</span><span class="run-date">'+d+'</span></div>' +
        '<div class="history-stats">' +
          '<span class="hs-ok">'+r.totalDone+' done</span>' +
          '<span class="hs-fail">'+r.totalFailed+' failed</span>' +
          '<span>/'+r.agentCount+' total</span>' +
          '<span style="color:var(--text-dim);margin-left:4px">'+dur+'</span>' +
        '</div></div>' +
        '<div class="history-body" id="hb-'+i+'"></div></div>';
    }).join('');
  });
}

function toggleHistory(idx, runId) {
  var body = document.getElementById('hb-' + idx);
  if (body.classList.contains('open')) { body.classList.remove('open'); return; }
  if (body.dataset.loaded) { body.classList.add('open'); return; }
  body.innerHTML = '<div style="padding:8px;color:var(--text-dim)">Loading...</div>';
  body.classList.add('open');
  fetch('/api/runs/' + runId).then(function(r){return r.json();}).then(function(data) {
    body.dataset.loaded = '1';
    body.innerHTML = data.agents.map(function(r) {
      var cls = (r.status==='done'||r.status==='connected') ? 'ha-done' : 'ha-failed';
      var elapsed = r.finishedAt ? ((r.finishedAt - r.startedAt)/1000).toFixed(1) : '?';
      return '<div class="history-agent '+cls+'">' +
        '<div class="ha-header"><span class="ha-name">'+esc(r.username)+'</span>' +
        '<span class="badge badge-'+r.status+'">'+r.status+'</span></div>' +
        '<div class="ha-model">'+esc(r.model)+'</div>' +
        '<div class="ha-detail">' +
          (r.gitlabUrl ? '<a href="'+r.gitlabUrl+'" target="_blank">'+esc(r.gitlabUrl)+'</a> &middot; ' : '') +
          elapsed+'s &middot; '+r.stepCount+' cmds' +
          (r.gameToken ? ' &middot; <span style="color:var(--green)">has token</span>' : '') +
          (r.error ? ' &middot; <span style="color:var(--red)">'+esc(r.error)+'</span>' : '') +
        '</div>' +
        '<span class="ha-msgs-toggle" data-agent="'+esc(r.id)+'" onclick="event.stopPropagation();toggleAgentMsgs(this)">Show messages</span>' +
        '<div class="ha-msgs" id="hm-'+esc(r.id)+'"></div></div>';
    }).join('');
  });
}

function toggleAgentMsgs(el) {
  var agentId = el.dataset.agent;
  var container = document.getElementById('hm-' + agentId);
  if (container.classList.contains('open')) { container.classList.remove('open'); return; }
  if (container.dataset.loaded) { container.classList.add('open'); return; }
  container.innerHTML = '<div style="padding:4px 8px;color:var(--text-dim);font-size:0.62rem">Loading...</div>';
  container.classList.add('open');
  fetch('/api/agents/' + agentId + '/messages').then(function(r){return r.json();}).then(function(msgs) {
    container.dataset.loaded = '1';
    container.innerHTML = msgs.map(function(m) {
      return '<div class="msg msg-'+m.role+'"><span class="msg-ts">'+fmtT(m.timestamp)+'</span>'+esc(m.content)+'</div>';
    }).join('');
  });
}

function loadExperiments() {
  fetch('/api/experiments').then(function(r){return r.json();}).then(function(rows) {
    var table = document.getElementById('exp-table');
    var tbody = document.getElementById('exp-tbody');
    var empty = document.getElementById('exp-empty');
    if (!rows.length) { table.style.display='none'; empty.style.display=''; return; }
    table.style.display=''; empty.style.display='none';
    tbody.innerHTML = rows.map(function(r) {
      var statusColor = r.status === 'keep' ? 'var(--green)' : r.status === 'discard' ? 'var(--red)' : 'var(--amber)';
      var pr = r.pass_rate || '';
      var nums = pr.match(/(\d+)\/(\d+)/);
      var pct = nums ? Math.round(parseInt(nums[1])/parseInt(nums[2])*100) : 0;
      var barColor = pct >= 30 ? 'var(--green)' : pct >= 15 ? 'var(--amber)' : 'var(--red)';
      return '<tr>' +
        '<td style="color:var(--text-dim)">' + esc(r._index) + '</td>' +
        '<td style="font-family:var(--mono);font-size:0.65rem;color:var(--cyan)">' + esc(r.commit || '') + '</td>' +
        '<td><div style="display:flex;align-items:center;gap:6px"><div style="width:40px;height:6px;background:var(--bg-0);border-radius:3px;overflow:hidden"><div style="width:'+pct+'%;height:100%;background:'+barColor+';border-radius:3px"></div></div><span style="font-size:0.7rem;font-weight:600">' + esc(pr) + '</span></div></td>' +
        '<td style="font-size:0.65rem;color:var(--text-dim)">' + (r.elapsed_sec ? Math.round(r.elapsed_sec/60)+'m' : '') + '</td>' +
        '<td style="color:'+statusColor+';font-size:0.65rem;font-weight:600;text-transform:uppercase">' + esc(r.status || '') + '</td>' +
        '<td style="font-size:0.62rem;color:var(--text);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(r.description || '')+'">' + esc(r.description || '') + '</td>' +
        '</tr>';
    }).join('');
  });
}
</script>
</body>
</html>`;
}

// ── HTTP Server ────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function jsonRes(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

const httpServer = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    res.end(); return;
  }

  const url = new URL(req.url || "/", `http://localhost:${DASHBOARD_PORT}`);

  if (url.pathname === "/" || url.pathname === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(dashboardHTML());
    return;
  }

  if (url.pathname === "/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
    const allAgents = Array.from(agents.values());
    const progress = activeRuns.size > 0 ? getAggregateProgress() : null;
    res.write(`event: init\ndata: ${JSON.stringify({ agents: allAgents, progress })}\n\n`);
    const onEvent = (ev: unknown) => { res.write(`event: event\ndata: ${JSON.stringify(ev)}\n\n`); };
    bus.on("event", onEvent);
    const hb = setInterval(() => res.write(`: hb\n\n`), 10000);
    req.on("close", () => { bus.off("event", onEvent); clearInterval(hb); });
    return;
  }

  if (url.pathname === "/api/start" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const count = Math.min(Math.max(Number(body.agents) || 1, 1), 10);
      const model = body.model || undefined;
      const runId = await launchRun(count, model);
      jsonRes(res, 200, { ok: true, runId, count });
    } catch (err) {
      jsonRes(res, 400, { error: (err as Error).message });
    }
    return;
  }

  if (url.pathname === "/api/start-all" && req.method === "POST") {
    try {
      const raw = req.headers["content-length"] && Number(req.headers["content-length"]) > 0 ? await readBody(req) : "";
      const body = raw ? JSON.parse(raw) : {};
      const concurrency = Math.min(Math.max(Number(body.concurrency) || 5, 1), 10);
      const runId = await launchAllModels(concurrency);
      jsonRes(res, 200, { ok: true, runId, modelCount: TOOL_MODELS.length });
    } catch (err) {
      jsonRes(res, 400, { error: (err as Error).message });
    }
    return;
  }

  if (url.pathname === "/api/cancel-run" && req.method === "POST") {
    loopMode = false;
    for (const rp of activeRuns.values()) rp.cancelled = true;
    emit("loop-status", { looping: false });
    jsonRes(res, 200, { ok: true, cancelled: activeRuns.size });
    return;
  }

  if (url.pathname === "/api/start-loop" && req.method === "POST") {
    loopMode = true;
    emit("loop-status", { looping: true });
    if (activeRuns.size === 0) {
      const runId = await launchAllModels(5);
      jsonRes(res, 200, { ok: true, looping: true, runId });
    } else {
      jsonRes(res, 200, { ok: true, looping: true, message: "Will continue after current run" });
    }
    return;
  }

  if (url.pathname === "/api/stop-loop" && req.method === "POST") {
    loopMode = false;
    emit("loop-status", { looping: false });
    jsonRes(res, 200, { ok: true, looping: false });
    return;
  }

  if (url.pathname === "/api/runs" && req.method === "GET") {
    jsonRes(res, 200, listRuns());
    return;
  }

  if (url.pathname.startsWith("/api/runs/") && req.method === "GET") {
    const runId = url.pathname.slice("/api/runs/".length);
    const runAgents = getAgentsForRun(runId);
    if (!runAgents.length) { jsonRes(res, 404, { error: "Run not found" }); return; }
    jsonRes(res, 200, { runId, agents: runAgents });
    return;
  }

  if (url.pathname.startsWith("/api/agents/") && url.pathname.endsWith("/messages") && req.method === "GET") {
    const agentId = url.pathname.slice("/api/agents/".length, -"/messages".length);
    jsonRes(res, 200, getMessagesForAgent(agentId));
    return;
  }

  if (url.pathname === "/api/model-stats" && req.method === "GET") {
    const stats = listModelStats();
    const paramMapLocal: Record<string, number | null> = {};
    TOOL_MODELS.forEach(function(m) { paramMapLocal[m.id] = m.active_params_b; });
    const enriched = stats.map(function(s) {
      return { ...s, params: paramMapLocal[s.model] || null };
    });
    jsonRes(res, 200, enriched);
    return;
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    jsonRes(res, 200, TOOL_MODELS);
    return;
  }

  if (url.pathname === "/api/experiments" && req.method === "GET") {
    try {
      const tsvPath = resolve(__dirname, "../results.tsv");
      const tsv = readFileSync(tsvPath, "utf-8");
      const lines = tsv.trim().split("\n");
      const header = lines[0]?.split("\t") || [];
      const rows = lines.slice(1).map((line, i) => {
        const cols = line.split("\t");
        const obj: Record<string, string> = {};
        header.forEach((h, j) => { obj[h] = cols[j] || ""; });
        obj._index = String(i + 1);
        return obj;
      });
      jsonRes(res, 200, rows);
    } catch {
      jsonRes(res, 200, []);
    }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ── Main ────────────────────────────────────────────────────

async function main() {
  const dbPath = resolve(__dirname, "../pi-test-results.db");
  initDb(dbPath);
  console.log(`  DB: ${dbPath}`);

  const orphaned = cleanupOrphanedRuns();
  if (orphaned > 0) console.log(`  Cleaned up ${orphaned} orphaned run(s).`);

  console.log(`  ${TOOL_MODELS.length} tool-calling models loaded.`);

  httpServer.listen(DASHBOARD_PORT, () => {
    console.log(`\n  Pi Agent Test Lab — http://localhost:${DASHBOARD_PORT}/\n`);
  });

  if (AUTO_ALL) {
    console.log(`  Auto-launching all ${TOOL_MODELS.length} models...`);
    await launchAllModels();
  }
}

main();
