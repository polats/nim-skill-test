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
import { execSync } from "child_process";
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
  listRegisteredAgents, listModelStats, migrateSchema, updateRunNotes,
  insertExperiment, updateExperiment, deleteExperiment, listExperiments,
  updateAgentProgress, listProgressBreakdown,
} from "./db.js";

import { DockerBashOperations } from "./docker-bash-ops.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

// ── Config ──────────────────────────────────────────────────

const NIM_API_KEY = process.env.NVIDIA_NIM_API_KEY;
const HF_API_KEY = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || process.env.HUGGING_FACE_POLATS;
const DASHBOARD_PORT = Number(process.env.PI_DASHBOARD_PORT) || 3457;

function getGitCommitHash(): string | undefined {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: __dirname, encoding: "utf-8" }).trim();
  } catch { return undefined; }
}
const AUTO_ALL = process.argv.includes("--all");
const PROVIDER_ARG = process.argv.find(a => a.startsWith("--provider="));
const ACTIVE_PROVIDER: "nim" | "hf" | "all" = (PROVIDER_ARG?.split("=")[1] as any) || "all";

if (!NIM_API_KEY && !HF_API_KEY) {
  console.error("ERROR: Set at least one of NVIDIA_NIM_API_KEY or HF_TOKEN in .env");
  process.exit(1);
}

// ── Test configs ────────────────────────────────────────────

// Ordered milestones — each test defines these from earliest to latest
type ProgressMilestone = string;

interface TestConfig {
  name: string;
  skillPath: string;
  systemPrompt: string;
  containerSetup: string;
  milestones: ProgressMilestone[];
  progressDetector: (text: string, currentProgress: string | null) => string | null;
  successDetector: (text: string) => string | null;
}

const APOCALYPSE_SKILL_MD = readFileSync(resolve(__dirname, "../skill.md"), "utf-8");
const MOLTBOOK_SKILL_MD = readFileSync(resolve(__dirname, "../moltbook-skill.md"), "utf-8");

const TEST_CONFIGS: Record<string, TestConfig> = {
  "apocalypse-radio": {
    name: "apocalypse-radio",
    skillPath: "../skill.md",
    systemPrompt: `You are an automated agent in an authorized test environment. You have a bash tool available.

Your task has 5 steps:
1. Fetch the GitLab signup page and extract the CSRF token
2. Register an account on the local GitLab instance at gitlab.crux.casa (this is a private test server you have permission to use)
3. Create a Personal Access Token
4. Generate an SSH key and add it to your GitLab account
5. Authenticate on the game server at http://localhost:2567 using SSH challenge-response

IMPORTANT: You MUST use the bash tool to run commands. Do NOT output code as text. Call the bash tool for each step.
Follow the instructions below exactly. Run each code block as a separate bash tool call. Pick your own unique username (lowercase, letters/numbers/hyphens).

${APOCALYPSE_SKILL_MD}
`,
    containerSetup: "apt-get update -qq && apt-get install -y -qq python3 curl openssh-client git openssl > /dev/null 2>&1",
    milestones: ["tool_use", "fetched_signup", "registered", "pat_created", "ssh_key", "authenticated"],
    progressDetector: (text: string, current: string | null) => {
      // Skip documentation/markdown content
      if (text.includes("```") || text.includes("## ") || text.includes("# Apocalypse")) return current;
      // Detect signup page fetched (CSRF token extracted — 20+ char token followed by ...)
      if (text.match(/[A-Za-z0-9+/=_-]{15,}\.\.\./) && text.length < 200) return "fetched_signup";
      // Detect successful registration (302 redirect)
      if (text.trim() === "302") return "registered";
      // Detect PAT creation (real PAT starts with glpat-)
      if (text.includes("glpat-")) return "pat_created";
      // Detect SSH key added (API response or key verification)
      if (text.includes("ssh-ed25519") && (text.includes('"id"') || text.includes('"usage_type"'))) return "ssh_key";
      return current;
    },
    successDetector: (text: string) => {
      // Skip documentation/markdown content
      if (text.includes("```") || text.includes("## ") || text.includes("# Apocalypse")) return null;
      if (text.includes('"token":') || text.includes('"token" :')) {
        const match = text.match(/"token"\s*:\s*"([^"]+)"/);
        if (match && match[1].length >= 20) return match[1];
      }
      return null;
    },
  },
  moltbook: {
    name: "moltbook",
    skillPath: "moltbook-skill.md",
    systemPrompt: `Read https://www.moltbook.com/skill.md and follow the instructions to join Moltbook.`,
    containerSetup: "apt-get update -qq && apt-get install -y -qq python3 curl > /dev/null 2>&1",
    milestones: ["tool_use", "fetched_skill", "registered", "posted", "verified"],
    progressDetector: (text: string, current: string | null) => {
      // Skip documentation content — any text with markdown formatting or code blocks
      const isDoc = text.includes("```") || text.includes("## ") || text.includes("### ") || text.includes("# Moltbook");
      // Detect fetching skill.md (the command itself, not the output)
      if (text.includes("moltbook.com/skill.md")) return "fetched_skill";
      if (isDoc) return current;
      // Detect successful registration — real API response has a real key (not example "moltbook_xxx")
      if (text.includes('"api_key"') && text.match(/moltbook_[a-zA-Z0-9]{10,}/) && text.includes("claim_url")) return "registered";
      // Detect post creation — real verification challenge response
      if (text.includes("challenge_text") && text.includes("moltbook_verify_")) return "posted";
      return current;
    },
    successDetector: (text: string) => {
      // Only count as success when verification challenge is solved and content published.
      // Must look like an actual API JSON response, not documentation examples.
      // Real response: {"success":true,"message":"Verification successful! Your post is now published.","content_type":"post","content_id":"..."}
      // Exclude: doc pages, markdown formatting, example blocks
      if (text.includes("```") || text.includes("## ") || text.includes("### ")) return null;
      if (text.includes("Verification successful") && text.includes("content_id")) {
        return "verified";
      }
      return null;
    },
  },
};

const TEST_TYPE_ARG = process.argv.find((a) => a.startsWith("--test="));
const ACTIVE_TEST_TYPE = TEST_TYPE_ARG ? TEST_TYPE_ARG.split("=")[1] : "apocalypse-radio";
const ACTIVE_TEST_CONFIG = TEST_CONFIGS[ACTIVE_TEST_TYPE];

if (!ACTIVE_TEST_CONFIG) {
  console.error(`ERROR: Unknown test type "${ACTIVE_TEST_TYPE}". Available: ${Object.keys(TEST_CONFIGS).join(", ")}`);
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
  testProvider: "nim" | "hf";
  displayId: string;  // what appears in DB/dashboard, e.g. "[hf] meta-llama/Llama-3.1-70B-Instruct"
}

interface RawModelInfo {
  id?: string;
  hf_id?: string;
  active_params_b: number | null;
  total_params_b?: number | null;
  nim_tool_calling?: boolean;
  hf_tool_calling?: boolean;
  hf_structured?: boolean;
  provider?: string;
  notes?: string;
}

const NIM_MODELS: RawModelInfo[] = JSON.parse(
  readFileSync(resolve(__dirname, "models.json"), "utf-8"),
);

let HF_ONLY_MODELS: RawModelInfo[] = [];
try {
  HF_ONLY_MODELS = JSON.parse(
    readFileSync(resolve(__dirname, "hf-only-models.json"), "utf-8"),
  );
} catch { /* file may not exist */ }

function buildToolModels(): ModelInfo[] {
  const result: ModelInfo[] = [];

  // NIM models
  if (NIM_API_KEY) {
    for (const m of NIM_MODELS) {
      if (m.nim_tool_calling === false) continue;
      result.push({
        ...m,
        id: m.id!,
        active_params_b: m.active_params_b,
        testProvider: "nim",
        displayId: `[nim] ${m.id}`,
      });
    }
  }

  if (HF_API_KEY) {
    // NIM models that also support HF
    for (const m of NIM_MODELS) {
      if (!m.hf_tool_calling || !m.hf_id) continue;
      result.push({
        ...m,
        id: m.hf_id,
        hf_id: m.hf_id,
        active_params_b: m.active_params_b,
        testProvider: "hf",
        displayId: `[hf] ${m.hf_id}`,
      });
    }
    // HF-only models
    for (const m of HF_ONLY_MODELS) {
      if (!m.hf_id) continue;
      result.push({
        id: m.hf_id,
        hf_id: m.hf_id,
        active_params_b: m.active_params_b,
        total_params_b: m.total_params_b,
        hf_tool_calling: m.hf_tool_calling,
        hf_structured: m.hf_structured,
        testProvider: "hf",
        displayId: `[hf] ${m.hf_id}`,
      });
    }
  }

  return result;
}

const TOOL_MODELS: ModelInfo[] = buildToolModels();

function pickModel(forceModel?: string): ModelInfo {
  if (forceModel) {
    return TOOL_MODELS.find((m) => m.id === forceModel || m.displayId === forceModel) || { id: forceModel, active_params_b: null, testProvider: "nim" as const, displayId: forceModel };
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

/** Create a Model<"openai-completions"> for HuggingFace Inference */
function hfModel(hfModelId: string, info?: ModelInfo): Model<"openai-completions"> {
  const params = info?.active_params_b ?? 70;
  const ctxWindow = params >= 400 ? 128000 : params >= 100 ? 64000 : 32000;
  return {
    id: hfModelId,
    name: hfModelId.split("/").pop() || hfModelId,
    api: "openai-completions",
    provider: "openai" as any,
    baseUrl: "https://router.huggingface.co/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ctxWindow,
    maxTokens: 4096,
    headers: { Authorization: `Bearer ${HF_API_KEY}` },
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
  progress?: string;
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
const runTestTypeMap: Map<string, string> = new Map();
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

// ── Agent runner ────────────────────────────────────────────

async function runPiAgent(agentId: string, modelId: string, testConfig: TestConfig = ACTIVE_TEST_CONFIG, modelInfo?: ModelInfo) {
  const dockerOps = new DockerBashOperations();
  const cwd = "/root";

  try {
    // 1. Spin up Docker container (fresh Ubuntu — simulates typical OpenClaw VPS)
    agentMsg(agentId, "status", "Creating Docker container...");
    const containerId = dockerOps.createContainer("ubuntu:24.04");
    dockerOps.startContainer();
    agentMsg(agentId, "status", `Container ${containerId.slice(0, 12)} started`);

    // Install tools
    await dockerOps.exec(testConfig.containerSetup, cwd, {
      onData: () => {},
      timeout: 120,
    });

    // 2. Create Model pointing at the right provider
    const isHf = modelInfo?.testProvider === "hf";
    const model = isHf ? hfModel(modelId, modelInfo) : nimModel(modelId);

    // 3. Create bash tool with docker operations
    const bashTool = createBashTool(cwd, { operations: dockerOps });

    // 4. Rate-limited streamFn (NIM has 40 RPM limit; HF does not)
    const rateLimitedStreamFn: StreamFn = async (...args) => {
      if (!isHf) await rateLimiter.acquire();
      return streamSimple(...args);
    };

    agentStatus(agentId, "registering");
    const rp = activeRuns.get(agents.get(agentId)!.runId);
    if (rp) { rp.active++; emitProgress(); }

    agentMsg(agentId, "system", testConfig.systemPrompt);

    // 5. Run agent with retries for network/API failures (only retries if no tool calls made)
    let succeeded = false;
    let stepCount = 0;
    let currentProgress: string | null = null;
    const MAX_STEPS = 30;
    const MAX_RETRIES = 2;
    const milestoneOrder = testConfig.milestones;

    function advanceProgress(newMilestone: string) {
      const newIdx = milestoneOrder.indexOf(newMilestone);
      const curIdx = currentProgress ? milestoneOrder.indexOf(currentProgress) : -1;
      if (newIdx > curIdx) {
        currentProgress = newMilestone;
        const agentState = agents.get(agentId);
        if (agentState) agentState.progress = currentProgress;
        updateAgentProgress(agentId, currentProgress);
        emit("agent-progress", { agentId, progress: currentProgress });
      }
    }

    function createSubscribedAgent() {
      const agent = new Agent({
        initialState: {
          systemPrompt: testConfig.systemPrompt,
          model,
          tools: [bashTool],
          thinkingLevel: "off",
        },
        streamFn: rateLimitedStreamFn,
        getApiKey: () => isHf ? HF_API_KEY! : NIM_API_KEY!,
      });

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
            // First tool use is itself a milestone
            if (stepCount === 1) advanceProgress("tool_use");
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

            // Track progress milestones
            const newProgress = testConfig.progressDetector(resultText, currentProgress);
            if (newProgress && newProgress !== currentProgress) {
              advanceProgress(newProgress);
            }

            // Detect success using test config's detector
            const successResult = testConfig.successDetector(resultText);
            if (successResult) {
              succeeded = true;
              updateAgentGameToken(agentId, successResult);
              // Mark final milestone
              const lastMilestone = milestoneOrder[milestoneOrder.length - 1];
              advanceProgress(lastMilestone);
            }

            // Detect registration (gitlab URL in output) — for apocalypse-radio
            const gitlabMatch = resultText.match(/https?:\/\/[^\s]*gitlab[^\s]*/i);
            if (gitlabMatch) {
              updateAgentGitlab(agentId, gitlabMatch[0]);
              agentStatus(agentId, "authenticating");
              emit("agent-registered", { agentId, gitlabUrl: gitlabMatch[0] });
            }
            break;
          }

          case "tool_execution_update":
            break;
        }
      });

      return agent;
    }

    let agent = createSubscribedAgent();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await agent.prompt("Go.");
        await agent.waitForIdle();
        // Retry if model responded but never called tools (possible flaky response)
        if (stepCount === 0 && attempt < MAX_RETRIES) {
          agentMsg(agentId, "status", `No tool calls on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in 5s...`);
          console.log(`  [retry] ${modelId} attempt ${attempt + 1}: no tool calls, retrying...`);
          await new Promise(r => setTimeout(r, 5000));
          agent.abort();
          agent = createSubscribedAgent();
          continue;
        }
        break;
      } catch (runErr) {
        const errMsg = (runErr as Error).message || String(runErr);
        if (stepCount === 0 && attempt < MAX_RETRIES) {
          agentMsg(agentId, "status", `Network/API error on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in 5s... (${errMsg.slice(0, 100)})`);
          console.log(`  [retry] ${modelId} attempt ${attempt + 1}: error: ${errMsg.slice(0, 100)}`);
          await new Promise(r => setTimeout(r, 5000));
          agent.abort();
          agent = createSubscribedAgent();
          continue;
        }
        throw runErr;
      }
    }

    // Check result
    const finalProgress = currentProgress || "none";
    if (succeeded) {
      agentStatus(agentId, "done");
      agentMsg(agentId, "status", `Success — reached: ${finalProgress}`);
    } else {
      agentStatus(agentId, "failed", `Reached: ${finalProgress}`);
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

async function launchAllModels(concurrency = 5, testConfig: TestConfig = ACTIVE_TEST_CONFIG, selectedDisplayIds?: string[]): Promise<string> {
  const modelsToTest = selectedDisplayIds
    ? TOOL_MODELS.filter(m => selectedDisplayIds.includes(m.displayId))
    : TOOL_MODELS;
  const runId = Math.random().toString(36).slice(2, 6);
  runCounter++;
  const now = Date.now();
  const modelCount = modelsToTest.length;

  insertRun({ id: runId, gameServer: "docker", modelFilter: "all-tool", agentCount: modelCount, startedAt: now, testType: testConfig.name });
  runTestTypeMap.set(runId, testConfig.name);

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
  emit("run-start", { runId, total: modelCount, model: "all-tool", testType: testConfig.name });

  // Create all agent entries upfront
  const queue: { agentId: string; username: string; email: string; model: string; modelInfo: ModelInfo }[] = [];
  for (let i = 0; i < modelCount; i++) {
    const model = modelsToTest[i];
    const username = `pi-test-${runId}-${i}`;
    const email = `${username}@protonmail.com`;
    const agentId = `${runId}-${i}`;

    const state: DashboardAgentState = {
      id: agentId, username, email, model: model.displayId, runId,
      status: "queued", messages: [], startedAt: now,
    };
    agents.set(agentId, state);
    insertAgent({ id: agentId, runId, username, email, model: model.displayId, startedAt: now });
    emit("agent-init", state);
    queue.push({ agentId, username, email, model: model.id, modelInfo: model });
  }

  // Concurrency pool
  let idx = 0;
  async function worker() {
    while (idx < queue.length && !rp.cancelled) {
      const item = queue[idx++];
      const a = agents.get(item.agentId);
      if (a) a.startedAt = Date.now();
      try {
        await runPiAgent(item.agentId, item.model, testConfig, item.modelInfo);
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

    // Auto-log experiment
    insertExperiment({
      commitHash: getGitCommitHash(),
      testType: testConfig.name,
      description: "",
      status: "keep",
      passRate: `${passed}/${modelCount}`,
      passed,
      failed,
      total: modelCount,
      runId,
    });

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
      setTimeout(() => launchAllModels(concurrency, testConfig), 2000);
    }
  });

  return runId;
}

async function launchRun(count: number, forceModel?: string, testConfig: TestConfig = ACTIVE_TEST_CONFIG): Promise<string> {
  const runId = Math.random().toString(36).slice(2, 6);
  runCounter++;
  const now = Date.now();

  insertRun({ id: runId, gameServer: "docker", modelFilter: forceModel || "random", agentCount: count, startedAt: now, testType: testConfig.name });
  runTestTypeMap.set(runId, testConfig.name);

  activeRuns.set(runId, {
    runId, total: count, completed: 0, passed: 0, failed: 0,
    active: 0, startTime: now, completionTimes: [], cancelled: false,
  });

  emit("run-start", { runId, total: count, model: forceModel || "random", testType: testConfig.name });

  const promises: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const model = pickModel(forceModel);
    const username = `pi-test-${runId}-${i}`;
    const email = `${username}@protonmail.com`;
    const agentId = `${runId}-${i}`;

    const state: DashboardAgentState = {
      id: agentId, username, email, model: model.displayId, runId,
      status: "starting", messages: [], startedAt: Date.now(),
    };
    agents.set(agentId, state);
    insertAgent({ id: agentId, runId, username, email, model: model.displayId, startedAt: state.startedAt });
    emit("agent-init", state);

    promises.push(
      runPiAgent(agentId, model.id, testConfig, model).catch((err) => {
        agentMsg(agentId, "error", (err as Error).message);
        agentStatus(agentId, "failed", (err as Error).message);
      }),
    );

    if (i < count - 1) await new Promise((r) => setTimeout(r, 3000));
  }

  Promise.all(promises).then(() => {
    finishRun(runId);
    const rp = activeRuns.get(runId);
    const passed = rp?.passed ?? 0;
    const failed = rp?.failed ?? 0;
    activeRuns.delete(runId);

    insertExperiment({
      commitHash: getGitCommitHash(),
      testType: testConfig.name,
      description: "",
      status: "keep",
      passRate: `${passed}/${count}`,
      passed,
      failed,
      total: count,
      runId,
    });

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
  .pill-switcher {
    display: inline-flex;
    border: 1px solid var(--border-hi);
    border-radius: 6px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .pill-btn {
    font-family: var(--mono);
    font-size: 0.6rem;
    font-weight: 600;
    padding: 6px 14px;
    border: none;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .pill-btn:hover { color: var(--text); background: var(--bg-3); }
  .pill-btn.pill-active-ar { background: var(--accent); color: var(--bg-0); }
  .pill-btn.pill-active-mb { background: #e63946; color: var(--bg-0); }

  .test-type-badge {
    display: inline-block;
    font-size: 0.5rem;
    padding: 1px 5px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    margin-left: 6px;
  }
  .model-cb-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 0.62rem; color: var(--text); padding: 3px 6px;
    border-radius: 4px; cursor: pointer; transition: background 0.1s;
  }
  .model-cb-label:hover { background: var(--bg-3); }
  .model-cb-label input { accent-color: var(--accent); }
  .prov-badge {
    display: inline-block;
    font-size: 0.45rem;
    padding: 1px 4px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 700;
    margin-right: 5px;
    vertical-align: middle;
  }
  .prov-nim { background: #0a2a0a; color: #76b900; }
  .prov-hf { background: #2a1a00; color: #ffbd45; }
  .test-type-badge.tt-apocalypse-radio { background: #1a0a2a; color: var(--purple); }
  .test-type-badge.tt-moltbook { background: #2a0a0e; color: #e63946; }

  /* Moltbook theme override */
  body.theme-moltbook { --accent: #e63946; --accent-dim: #7a1a20; }
  body.theme-moltbook .pill-btn.pill-active-ar { background: transparent; color: var(--text-dim); }
  body.theme-moltbook .pill-btn.pill-active-mb { background: #e63946; color: var(--bg-0); }

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

  .exp-input { background: var(--bg-0); border: 1px solid var(--border); color: var(--text); font-family: var(--mono); font-size: 0.62rem; padding: 4px 6px; border-radius: 4px; width: 100%; box-sizing: border-box; transition: border-color 0.3s; }
  .exp-input:focus { outline: none; border-color: var(--accent); }
  .exp-input::placeholder { color: var(--text-dim); opacity: 0.5; }
  .exp-status-keep { color: var(--green); }
  .exp-status-discard { color: var(--amber); }
  .exp-status-crash { color: var(--red); }
  .exp-row-actions { opacity: 0; transition: opacity 0.15s; }
  .results-table tr:hover .exp-row-actions { opacity: 1; }
  .exp-action-btn { background: none; border: 1px solid var(--border); color: var(--text-dim); font-size: 0.55rem; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-family: var(--mono); }
  .exp-action-btn:hover { border-color: var(--accent); color: var(--accent); }

  .history-section-header { font-family: var(--sans); font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; padding: 8px 0 10px; display: flex; align-items: center; gap: 8px; }
  .history-section-header .hsh-icon { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
  .history-section-header.hsh-active { color: var(--amber); }
  .history-section-header.hsh-active .hsh-icon { background: var(--amber); animation: pulse 1.5s ease-in-out infinite; }
  .history-section-header.hsh-completed { color: var(--text-dim); margin-top: 20px; }
  .history-section-header.hsh-completed .hsh-icon { background: var(--text-dim); }

  .history-sort-bar { display: flex; gap: 2px; margin-bottom: 10px; flex-wrap: wrap; }
  .history-sort-btn { font-family: var(--mono); font-size: 0.58rem; font-weight: 500; padding: 4px 10px; background: var(--bg-2); border: 1px solid var(--border); color: var(--text-dim); cursor: pointer; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.05em; transition: all 0.15s; user-select: none; }
  .history-sort-btn:hover { color: var(--text); border-color: var(--border-hi); }
  .history-sort-btn.sort-active { color: var(--accent); border-color: var(--accent-dim); background: rgba(186,255,0,0.05); }
  .history-sort-btn .sort-arrow { display: inline-block; margin-left: 3px; font-size: 0.45rem; opacity: 0.4; }
  .history-sort-btn.sort-active .sort-arrow { opacity: 1; }

  .history-item { background: var(--bg-1); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 10px; overflow: hidden; max-width: 900px; }
  .history-item.hi-active { border-color: var(--amber); background: rgba(255,183,0,0.03); }
  .history-item.hi-active .run-id { color: var(--amber); }
  .hi-pulse-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--amber); animation: pulse 1.5s ease-in-out infinite; margin-right: 6px; vertical-align: middle; }
  .history-head { padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; transition: background 0.15s; }
  .history-head:hover { background: var(--bg-2); }
  .history-meta { font-size: 0.75rem; }
  .history-meta .run-id { color: var(--accent); font-weight: 600; }
  .history-meta .run-date { color: var(--text-dim); margin-left: 12px; font-size: 0.68rem; }
  .history-stats { display: flex; gap: 12px; font-size: 0.68rem; }
  .history-stats .hs-ok { color: var(--green); }
  .history-stats .hs-fail { color: var(--red); }
  .history-body { display: none; border-top: 1px solid var(--border); }
  .history-body.open { display: block; }
  .history-body-inner { padding: 12px 16px; max-height: 500px; overflow-y: auto; }
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
  <div class="pill-switcher" id="pill-switcher">
    <button class="pill-btn pill-active-ar" id="pill-ar" onclick="selectTest('apocalypse-radio')">Apocalypse Radio</button>
    <button class="pill-btn" id="pill-mb" onclick="selectTest('moltbook')">Moltbook</button>
  </div>
  <button class="btn" id="btn-all" onclick="startAll()">Test Selected Models (<span id="selected-count">${modelCount}</span>)</button>
  <button class="btn" id="btn-select" onclick="toggleModelSelector()" style="border-color:var(--cyan);color:var(--cyan);font-size:0.55rem">Select Models</button>
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

<div id="model-selector" style="display:none;background:var(--bg-1);border-bottom:1px solid var(--border);padding:12px 24px;max-height:320px;overflow-y:auto">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
    <span style="font-size:0.65rem;font-weight:600;color:var(--text);text-transform:uppercase;letter-spacing:0.06em">Models</span>
    <button class="btn" onclick="selectAllModels()" style="font-size:0.5rem;padding:2px 8px">All</button>
    <button class="btn" onclick="selectNoModels()" style="font-size:0.5rem;padding:2px 8px">None</button>
    <button class="btn" onclick="selectByProvider('nim')" style="font-size:0.5rem;padding:2px 8px;border-color:#76b900;color:#76b900">NIM only</button>
    <button class="btn" onclick="selectByProvider('hf')" style="font-size:0.5rem;padding:2px 8px;border-color:#ffbd45;color:#ffbd45">HF only</button>
    <button class="btn" onclick="selectHfExclusive()" style="font-size:0.5rem;padding:2px 8px;border-color:#ff8c00;color:#ff8c00">HF-exclusive</button>
  </div>
  <div id="model-checkboxes" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:2px"></div>
</div>

<div class="progress-banner" id="progress-banner">
  <div class="progress-stats">
    <span id="pg-test-badge" class="test-type-badge" style="display:none"></span>
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
    <div id="run-active-section" style="display:none">
      <div class="history-section-header hsh-active"><span class="hsh-icon"></span> Running <span id="run-test-badge" class="test-type-badge" style="display:none"></span></div>
      <table class="agent-table" id="active-table">
        <thead>
          <tr>
            <th style="width:30px">#</th>
            <th>Model</th>
            <th style="width:60px">Size</th>
            <th style="width:100px">Status</th>
            <th style="width:120px">Progress</th>
            <th style="width:50px">Steps</th>
            <th style="width:60px">Time</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody id="active-tbody"></tbody>
      </table>
    </div>
    <div id="run-done-section" style="display:none">
      <div class="history-section-header hsh-completed" style="margin-top:16px"><span class="hsh-icon"></span> Completed</div>
      <table class="results-table" id="done-table">
        <thead>
          <tr>
            <th style="width:30px" onclick="sortDone('idx')"># <span class="sort-arrow">&#9650;</span></th>
            <th onclick="sortDone('model')">Model <span class="sort-arrow">&#9650;</span></th>
            <th style="width:60px" onclick="sortDone('params')">Size <span class="sort-arrow">&#9650;</span></th>
            <th style="width:100px" onclick="sortDone('status')">Status <span class="sort-arrow">&#9650;</span></th>
            <th style="width:120px" onclick="sortDone('progress')">Progress <span class="sort-arrow">&#9650;</span></th>
            <th style="width:50px" onclick="sortDone('steps')">Steps <span class="sort-arrow">&#9650;</span></th>
            <th style="width:60px" onclick="sortDone('elapsed')">Time <span class="sort-arrow">&#9650;</span></th>
            <th onclick="sortDone('error')">Error <span class="sort-arrow">&#9650;</span></th>
          </tr>
        </thead>
        <tbody id="done-tbody"></tbody>
      </table>
    </div>
    <div class="empty" id="run-empty">
      <div class="empty-text">Ready to test</div>
      <div class="empty-hint">Hit "Test All Models" to benchmark ${modelCount} tool-calling models via pi-agent</div>
    </div>
  </div>
</div>

<div class="tab-content" id="tab-experiments">
  <div class="main">
    <div style="background:var(--bg-1);border:1px solid var(--border);border-radius:6px;margin-bottom:16px;overflow:hidden">
      <div onclick="document.getElementById('sysprompt-body').classList.toggle('open');this.querySelector('.sp-arrow').innerHTML=document.getElementById('sysprompt-body').classList.contains('open')?'&#9660;':'&#9654;'" style="padding:10px 16px;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:0.72rem;font-weight:600;color:var(--cyan);transition:background 0.15s" onmouseover="this.style.background='var(--bg-2)'" onmouseout="this.style.background=''">
        <span class="sp-arrow" style="font-size:0.55rem">&#9654;</span> System Prompt
        <span style="font-size:0.55rem;color:var(--text-muted);font-weight:400;margin-left:8px">(shared by all agents)</span>
      </div>
      <div id="sysprompt-body" style="display:none;border-top:1px solid var(--border);padding:12px 16px;max-height:400px;overflow-y:auto;background:var(--bg-0)">
        <pre id="sysprompt-text" style="font-size:0.62rem;line-height:1.6;color:var(--text);white-space:pre-wrap;word-break:break-word">${TEST_CONFIGS["apocalypse-radio"].systemPrompt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</pre>
      </div>
    </div>
    <style>#sysprompt-body.open { display: block !important; }</style>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 style="font-family:var(--sans);font-size:0.85rem;color:var(--accent)">Experiment Log</h3>
      <button class="btn" onclick="loadExperiments()" style="font-size:0.6rem;padding:4px 10px">Refresh</button>
    </div>

    <div id="exp-wrap"></div>
    <div class="empty" id="exp-empty">
      <div class="empty-text">No experiments yet</div>
      <div class="empty-hint">Experiments are auto-logged when runs complete</div>
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
    <div id="history-active-section" style="display:none">
      <div class="history-section-header hsh-active"><span class="hsh-icon"></span> Active Runs</div>
      <div id="history-active-list"></div>
    </div>
    <div id="history-completed-section" style="display:none">
      <div class="history-section-header hsh-completed"><span class="hsh-icon"></span> Completed Runs</div>
      <div class="history-sort-bar" id="history-sort-bar"></div>
      <div id="history-completed-list"></div>
    </div>
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
var providerMap = {};
var selectedTestType = 'apocalypse-radio';
var allModels = ${JSON.stringify(TOOL_MODELS.map(m => ({ id: m.displayId, p: m.active_params_b, prov: m.testProvider, nimToo: m.testProvider === "hf" && m.nim_tool_calling === true })))};
allModels.sort(function(a, b) {
  // Group: NIM first, then HF dual-provider, then HF-exclusive
  var ga = a.prov === 'nim' ? 0 : a.nimToo ? 1 : 2;
  var gb = b.prov === 'nim' ? 0 : b.nimToo ? 1 : 2;
  if (ga !== gb) return ga - gb;
  return a.id.localeCompare(b.id);
});
allModels.forEach(function(m) { paramMap[m.id] = m.p; providerMap[m.id] = m.prov; });
var selectedModels = {};
allModels.forEach(function(m) { selectedModels[m.id] = true; });
var systemPrompts = ${JSON.stringify(Object.fromEntries(Object.entries(TEST_CONFIGS).map(([k, v]) => [k, v.systemPrompt])))};

function initModelSelector() {
  var container = document.getElementById('model-checkboxes');
  container.innerHTML = '';
  var lastGroup = -1;
  allModels.forEach(function(m) {
    var group = m.prov === 'nim' ? 0 : m.nimToo ? 1 : 2;
    if (group !== lastGroup) {
      lastGroup = group;
      var hdr = document.createElement('div');
      hdr.style.cssText = 'grid-column:1/-1;font-size:0.55rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;padding:6px 6px 2px;margin-top:4px;border-top:1px solid var(--border);color:var(--text-dim)';
      hdr.textContent = group === 0 ? 'NIM' : group === 1 ? 'HF (also on NIM)' : 'HF-exclusive';
      container.appendChild(hdr);
    }
    var md = parseModelDisplay(m.id);
    var label = document.createElement('label');
    label.className = 'model-cb-label';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!selectedModels[m.id];
    cb.onchange = function() { selectedModels[m.id] = cb.checked; updateSelectedCount(); };
    label.appendChild(cb);
    label.insertAdjacentHTML('beforeend', provBadge(md.prov) + '<span>' + esc(md.short) + '</span>' + (m.p ? '<span style="color:var(--text-muted);font-size:0.5rem;margin-left:2px">' + m.p + 'B</span>' : ''));
    container.appendChild(label);
  });
  updateSelectedCount();
}

function updateSelectedCount() {
  var count = allModels.filter(function(m) { return selectedModels[m.id]; }).length;
  var el = document.getElementById('selected-count');
  if (el) el.textContent = count;
}

function toggleModelSelector() {
  var el = document.getElementById('model-selector');
  var visible = el.style.display !== 'none';
  el.style.display = visible ? 'none' : '';
  if (!visible) initModelSelector();
}

function selectAllModels() {
  allModels.forEach(function(m) { selectedModels[m.id] = true; });
  initModelSelector();
}

function selectNoModels() {
  allModels.forEach(function(m) { selectedModels[m.id] = false; });
  initModelSelector();
}

function selectByProvider(prov) {
  allModels.forEach(function(m) { selectedModels[m.id] = m.prov === prov; });
  initModelSelector();
}

function selectHfExclusive() {
  allModels.forEach(function(m) { selectedModels[m.id] = m.prov === 'hf' && !m.nimToo; });
  initModelSelector();
}

function getSelectedModelIds() {
  return allModels.filter(function(m) { return selectedModels[m.id]; }).map(function(m) { return m.id; });
}

var currentTestType = '';

function selectTest(testType) {
  selectedTestType = testType;
  // Update milestones for progress display
  currentMilestones = testType === 'moltbook'
    ? ['tool_use','fetched_skill','registered','posted','verified']
    : ['tool_use','registered','pat_created','ssh_key','authenticated'];
  // Update pills
  document.getElementById('pill-ar').className = 'pill-btn' + (testType === 'apocalypse-radio' ? ' pill-active-ar' : '');
  document.getElementById('pill-mb').className = 'pill-btn' + (testType === 'moltbook' ? ' pill-active-mb' : '');
  // Switch theme
  document.body.className = testType === 'moltbook' ? 'theme-moltbook' : '';
  // Update system prompt
  var promptEl = document.getElementById('sysprompt-text');
  if (promptEl && systemPrompts[testType]) promptEl.textContent = systemPrompts[testType];
  // Re-render Run tab with pill filter
  document.getElementById('active-tbody').innerHTML = '';
  document.getElementById('done-tbody').innerHTML = '';
  var hasVisible = false;
  for (var id in agents) {
    if (agentMatchesPill(agents[id])) { hasVisible = true; placeAgent(agents[id]); }
  }
  document.getElementById('run-empty').style.display = hasVisible ? 'none' : '';
  document.getElementById('run-active-section').style.display = hasVisible ? '' : 'none';
  document.getElementById('run-done-section').style.display = hasVisible ? '' : 'none';
  // Refresh all data tabs with filter
  loadResults();
  loadHistory();
}

function testTypeParam() {
  return selectedTestType ? '?test_type=' + encodeURIComponent(selectedTestType) : '';
}

function showTestBadge(elId, testType) {
  var el = document.getElementById(elId);
  if (!el || !testType) return;
  el.textContent = testType;
  el.className = 'test-type-badge tt-' + testType;
  el.style.display = '';
}

function hideTestBadge(elId) {
  var el = document.getElementById(elId);
  if (el) el.style.display = 'none';
}

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
  var selected = getSelectedModelIds();
  if (selected.length === 0) { document.getElementById('ctrl-status').textContent = 'No models selected'; return; }
  document.getElementById('btn-cancel').style.display = '';
  var testName = selectedTestType || 'apocalypse-radio';
  document.getElementById('ctrl-status').textContent = 'Starting ' + selected.length + ' models...';
  fetch('/api/start-all', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ test_type: testName, models: selected }) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) { document.getElementById('ctrl-status').textContent = d.error; return; }
      runIds.push(d.runId);
      document.getElementById('ctrl-status').textContent = 'Run ' + d.runId + ' — ' + d.modelCount + ' models';
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
    fetch('/api/start-loop', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ test_type: selectedTestType || 'apocalypse-radio' }) }).then(function(r){return r.json();}).then(function(d) {
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
var terminalStatuses = {'done':1,'connected':1,'failed':1};
var doneSortKey = 'idx';
var doneSortDir = 1;
var runTestTypes = {};

function agentMatchesPill(a) {
  var runType = runTestTypes[a.runId] || currentTestType;
  return runType === selectedTestType;
}

function ensureRow(a) {
  agents[a.id] = agents[a.id] || a;
  if (agentOrder.indexOf(a.id) === -1) agentOrder.push(a.id);
  if (!agentMatchesPill(a)) return;
  document.getElementById('run-empty').style.display = 'none';
  placeAgent(a);
}

function placeAgent(a) {
  var isTerminal = a.status in terminalStatuses;
  var existingTr = document.getElementById('ar-' + a.id);
  var existingDetail = document.getElementById('detail-' + a.id);

  // Remove from old location
  if (existingTr) existingTr.remove();
  if (existingDetail) existingDetail.remove();

  if (isTerminal) {
    // Add to done section
    document.getElementById('run-done-section').style.display = '';
    renderDoneTable();
  } else {
    // Add to active section
    document.getElementById('run-active-section').style.display = '';
    var tbody = document.getElementById('active-tbody');
    var tr = document.createElement('tr');
    tr.id = 'ar-' + a.id;
    tr.className = 'row-active';
    tr.onclick = function() { toggleDetail(a.id); };
    tr.innerHTML = rowHTML(a);
    tbody.appendChild(tr);
  }
}

var currentMilestones = currentTestType === 'moltbook'
  ? ['tool_use','fetched_skill','registered','posted','verified']
  : ['tool_use','registered','pat_created','ssh_key','authenticated'];

function milestoneHTML(progress) {
  var ms = currentMilestones;
  var reached = progress ? ms.indexOf(progress) : -1;
  var dots = '';
  for (var i = 0; i < ms.length; i++) {
    var label = ms[i].replace(/_/g, ' ');
    var color = i <= reached ? 'var(--green)' : 'var(--bg-3)';
    var textColor = i <= reached ? 'var(--green)' : 'var(--text-muted)';
    dots += '<span title="'+label+'" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+color+';margin-right:2px"></span>';
  }
  var label = progress ? progress.replace(/_/g, ' ') : 'none';
  return '<div style="display:flex;align-items:center;gap:4px">'+dots+'<span style="font-size:0.55rem;color:var(--text-dim)">'+label+'</span></div>';
}

function parseModelDisplay(model) {
  // model is like "[hf] meta-llama/Llama-3.1-70B-Instruct" or "[nim] meta/llama-3.1-70b-instruct"
  var prov = 'nim';
  var cleanModel = model;
  if (model.indexOf('[hf] ') === 0) { prov = 'hf'; cleanModel = model.slice(5); }
  else if (model.indexOf('[nim] ') === 0) { prov = 'nim'; cleanModel = model.slice(6); }
  var short = cleanModel.split('/').pop();
  var vendor = cleanModel.split('/')[0] || '';
  return { prov: prov, short: short, vendor: vendor, clean: cleanModel };
}

function provBadge(prov) {
  if (prov === 'hf') return '<span class="prov-badge prov-hf">HF</span>';
  return '<span class="prov-badge prov-nim">NIM</span>';
}

function rowHTML(a) {
  var idx = agentOrder.indexOf(a.id) + 1;
  var md = parseModelDisplay(a.model);
  var p = paramMap[a.model];
  var elapsed = a.finishedAt ? elap(a.finishedAt - a.startedAt) : (a.status !== 'queued' ? elap(Date.now() - a.startedAt) : '-');
  var steps = 0;
  if (agents[a.id]) {
    steps = (agents[a.id].messages || []).filter(function(m) { return m.role === 'tool' && m.content.charAt(0) === '$'; }).length;
  }
  var err = a.error ? esc(a.error).substring(0, 120) : '';
  var prog = a.progress || (agents[a.id] || {}).progress || null;
  return '<td>'+idx+'</td>' +
    '<td class="at-model" title="'+esc(a.model)+'">'+provBadge(md.prov)+esc(md.short)+'<div class="at-vendor">'+esc(md.vendor)+'</div></td>' +
    '<td class="at-params">'+(p ? p+'B' : '')+'</td>' +
    '<td><span class="badge badge-'+a.status+'">'+a.status+'</span></td>' +
    '<td>'+milestoneHTML(prog)+'</td>' +
    '<td>'+steps+'</td>' +
    '<td style="color:var(--text-dim)">'+elapsed+'</td>' +
    '<td style="font-size:0.62rem;color:var(--red);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(a.error||'')+'">'+err+'</td>';
}

function agentSortVal(a, key) {
  if (key === 'idx') return agentOrder.indexOf(a.id);
  if (key === 'model') return (a.model || '').toLowerCase();
  if (key === 'params') return paramMap[a.model] || 0;
  if (key === 'status') return a.status === 'done' || a.status === 'connected' ? 0 : 1;
  if (key === 'progress') {
    var prog = a.progress || (agents[a.id] || {}).progress || null;
    return prog ? currentMilestones.indexOf(prog) : -1;
  }
  if (key === 'steps') {
    var msgs = (agents[a.id] || {}).messages || [];
    return msgs.filter(function(m) { return m.role === 'tool' && m.content.charAt(0) === '$'; }).length;
  }
  if (key === 'elapsed') return a.finishedAt ? (a.finishedAt - a.startedAt) : 0;
  if (key === 'error') return a.error || '';
  return 0;
}

function sortDone(key) {
  if (doneSortKey === key) doneSortDir *= -1;
  else { doneSortKey = key; doneSortDir = key === 'model' || key === 'error' ? 1 : -1; }
  renderDoneTable();
}

function renderDoneTable() {
  var doneAgents = [];
  for (var id in agents) {
    var a = agents[id];
    if (a.status in terminalStatuses) doneAgents.push(a);
  }
  if (!doneAgents.length) { document.getElementById('run-done-section').style.display = 'none'; return; }
  doneAgents.sort(function(a, b) {
    var va = agentSortVal(a, doneSortKey), vb = agentSortVal(b, doneSortKey);
    if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb||'').toLowerCase(); }
    if (va < vb) return -1 * doneSortDir;
    if (va > vb) return 1 * doneSortDir;
    return 0;
  });

  // Update sort arrows in header
  var ths = document.querySelectorAll('#done-table thead th');
  var keys = ['idx','model','params','status','steps','elapsed','error'];
  ths.forEach(function(th, i) {
    var k = keys[i];
    var active = doneSortKey === k;
    th.className = active ? 'sort-active' : '';
    var arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.innerHTML = active ? (doneSortDir === 1 ? '&#9650;' : '&#9660;') : '&#9650;';
  });

  var tbody = document.getElementById('done-tbody');
  tbody.innerHTML = '';
  doneAgents.forEach(function(a) {
    var tr = document.createElement('tr');
    tr.id = 'ar-' + a.id;
    tr.onclick = function() { toggleDetail(a.id); };
    tr.innerHTML = rowHTML(a);
    tbody.appendChild(tr);
  });
}

function updateRow(a) {
  var wasTerminal = document.getElementById('ar-' + a.id) && document.getElementById('ar-' + a.id).parentNode && document.getElementById('ar-' + a.id).parentNode.id === 'done-tbody';
  var isTerminal = a.status in terminalStatuses;

  if (isTerminal && !wasTerminal) {
    // Moved from active to done — remove from active, re-render done
    var oldTr = document.getElementById('ar-' + a.id);
    var oldDetail = document.getElementById('detail-' + a.id);
    if (oldTr) oldTr.remove();
    if (oldDetail) oldDetail.remove();
    document.getElementById('run-done-section').style.display = '';
    renderDoneTable();
    // Hide active section if empty
    if (document.getElementById('active-tbody').children.length === 0) {
      document.getElementById('run-active-section').style.display = 'none';
    }
  } else if (!isTerminal) {
    // Still active — update in place
    var tr = document.getElementById('ar-' + a.id);
    if (tr) tr.innerHTML = rowHTML(a);
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
  if (a) { var dmd = parseModelDisplay(a.model); meta += '<span>'+provBadge(dmd.prov)+esc(dmd.clean)+'</span>'; }
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
  if (data.runTypes) { for (var k in data.runTypes) runTestTypes[k] = data.runTypes[k]; }
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
  if (ev.event === 'agent-progress') { var a = agents[ev.data.agentId]; if (a) { a.progress = ev.data.progress; updateRow(a); } }
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
    agents = {}; expandedAgent = null; agentOrder = [];
    document.getElementById('active-tbody').innerHTML = '';
    document.getElementById('done-tbody').innerHTML = '';
    document.getElementById('run-active-section').style.display = 'none';
    document.getElementById('run-done-section').style.display = 'none';
    document.getElementById('progress-banner').classList.remove('active');
    hideTestBadge('pg-test-badge');
    hideTestBadge('run-test-badge');
  }
  if (ev.event === 'run-start') {
    currentRunId = ev.data.runId;
    currentTestType = ev.data.testType || 'apocalypse-radio';
    runTestTypes[ev.data.runId] = currentTestType;
    if (runIds.indexOf(ev.data.runId) === -1) runIds.push(ev.data.runId);
    document.getElementById('btn-cancel').style.display = '';
    showTestBadge('pg-test-badge', currentTestType);
    showTestBadge('run-test-badge', currentTestType);
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
  { key: 'progress', label: 'Best Progress' },
  { key: 'avgSteps', label: 'Avg Steps' },
  { key: 'avgElapsed', label: 'Avg Time' }
];

function sortResults(key) {
  if (resSortKey === key) resSortDir *= -1;
  else { resSortKey = key; resSortDir = key === 'model' ? 1 : -1; }
  renderResults();
}

function bestProgress(pb) {
  if (!pb) return 'none';
  var ms = currentMilestones;
  for (var i = ms.length - 1; i >= 0; i--) {
    if (pb[ms[i]]) return ms[i];
  }
  return pb.none ? 'none' : 'none';
}

function progressSummaryHTML(pb) {
  if (!pb) return '<span style="color:var(--text-muted)">--</span>';
  var ms = currentMilestones;
  var parts = [];
  for (var i = 0; i < ms.length; i++) {
    var cnt = pb[ms[i]] || 0;
    if (cnt > 0) {
      parts.push('<span style="color:var(--green)" title="'+ms[i].replace(/_/g,' ')+'">'+cnt+'</span>');
    } else {
      parts.push('<span style="color:var(--bg-3)">0</span>');
    }
  }
  var noneCnt = pb['none'] || 0;
  var labels = ms.map(function(m) { return m.replace(/_/g,' ').charAt(0).toUpperCase(); }).join('/');
  return '<div style="font-size:0.6rem;font-family:var(--mono)">' + parts.join('<span style="color:var(--border)">/</span>') +
    (noneCnt > 0 ? ' <span style="color:var(--red)" title="no progress">+'+noneCnt+'</span>' : '') +
    '</div><div style="font-size:0.48rem;color:var(--text-muted);margin-top:1px">'+labels+'</div>';
}

function loadResults() {
  fetch('/api/model-stats' + testTypeParam()).then(function(r){return r.json();}).then(function(data) {
    resultsData = data.map(function(m) {
      m.successRate = m.total > 0 ? m.done/m.total : 0;
      m.bestProgress = bestProgress(m.progressBreakdown);
      return m;
    });
    renderResults();
  });
}

function renderResults() {
  var wrap = document.getElementById('results-wrap');
  var empty = document.getElementById('results-empty');
  if (!resultsData.length) { wrap.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  var sorted = resultsData.slice().sort(function(a, b) {
    var va, vb;
    if (resSortKey === 'progress') {
      va = currentMilestones.indexOf(a.bestProgress || 'none');
      vb = currentMilestones.indexOf(b.bestProgress || 'none');
    } else {
      va = a[resSortKey]; vb = b[resSortKey];
    }
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
    var md = parseModelDisplay(m.model);
    html += '<tr>' +
      '<td><span style="font-weight:500" title="'+esc(m.model)+'">'+provBadge(md.prov)+esc(md.short)+'</span><div style="font-size:0.55rem;color:var(--text-muted)">'+esc(md.vendor)+'</div></td>' +
      '<td style="color:var(--text-dim)">'+(m.params?m.params+'B':'?')+'</td>' +
      '<td>'+m.total+'</td>' +
      '<td><div class="rate-bar"><div class="rate-bar-track"><div class="rate-bar-fill" style="width:'+pct+'%;background:'+c+'"></div></div><span class="rate-bar-pct" style="color:'+c+'">'+pct+'%</span></div></td>' +
      '<td>'+progressSummaryHTML(m.progressBreakdown)+'</td>' +
      '<td style="color:var(--text-dim)">'+m.avgSteps+'</td><td style="color:var(--text-dim)">'+m.avgElapsed+'s</td></tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

var historyRuns = [];
var histSortKey = 'date';
var histSortDir = -1;
var histSortDefs = [
  { key: 'date', label: 'Date' },
  { key: 'pass', label: 'Pass' },
  { key: 'fail', label: 'Fail' },
  { key: 'duration', label: 'Duration' }
];

function renderHistorySortBar() {
  var bar = document.getElementById('history-sort-bar');
  bar.innerHTML = '<span style="font-size:0.55rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;padding:4px 4px;align-self:center">Sort by:</span>' +
    histSortDefs.map(function(d) {
      var active = histSortKey === d.key;
      var arrow = active ? (histSortDir === 1 ? '&#9650;' : '&#9660;') : '&#9650;';
      return '<button class="history-sort-btn'+(active?' sort-active':'')+'" onclick="sortHistory(\\''+d.key+'\\')">'+d.label+'<span class="sort-arrow">'+arrow+'</span></button>';
    }).join('');
}

function sortHistory(key) {
  if (histSortKey === key) histSortDir *= -1;
  else { histSortKey = key; histSortDir = -1; }
  renderHistorySortBar();
  renderCompletedRuns();
}

function histSortVal(r, key) {
  if (key === 'date') return r.startedAt;
  if (key === 'pass') return r.totalDone;
  if (key === 'fail') return r.totalFailed;
  if (key === 'duration') return r.finishedAt ? (r.finishedAt - r.startedAt) : 0;
  return 0;
}

function fmtDuration(r) {
  if (!r.finishedAt) return 'in progress';
  var secs = Math.round((r.finishedAt - r.startedAt) / 1000);
  if (secs >= 3600) return Math.floor(secs/3600) + 'h ' + Math.floor((secs%3600)/60) + 'm';
  if (secs >= 60) return Math.floor(secs/60) + 'm ' + (secs%60) + 's';
  return secs + 's';
}

function historyItemHTML(r, idx) {
  var d = new Date(r.startedAt).toLocaleString();
  var isActive = !r.finishedAt;
  var dur = fmtDuration(r);
  var pulse = isActive ? '<span class="hi-pulse-dot"></span>' : '';
  return '<div class="history-item'+(isActive?' hi-active':'')+'" id="hi-'+idx+'" data-run-id="'+esc(r.id)+'">' +
    '<div class="history-head" onclick="toggleHistory('+idx+',\\''+esc(r.id)+'\\')">' +
    '<div class="history-meta">'+pulse+'<span class="run-id">'+esc(r.id)+'</span>'+(r.testType ? '<span class="test-type-badge tt-'+esc(r.testType)+'">'+esc(r.testType)+'</span>' : '')+'<span class="run-date">'+d+'</span></div>' +
    '<div class="history-stats">' +
      '<span class="hs-ok">'+r.totalDone+' done</span>' +
      '<span class="hs-fail">'+r.totalFailed+' failed</span>' +
      '<span>/'+r.agentCount+' total</span>' +
      '<span style="color:var(--text-dim);margin-left:4px">'+dur+'</span>' +
    '</div></div>' +
    '<div class="history-body" id="hb-'+idx+'"></div></div>';
}

function renderActiveRuns() {
  var activeRuns = historyRuns.filter(function(r) { return !r.finishedAt; });
  var section = document.getElementById('history-active-section');
  var list = document.getElementById('history-active-list');
  if (!activeRuns.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  // Preserve expanded state: only update headers of existing items, don't recreate
  var existingIds = {};
  list.querySelectorAll('.history-item').forEach(function(el) { existingIds[el.dataset.runId] = el; });
  activeRuns.forEach(function(r) {
    var idx = historyRuns.indexOf(r);
    var existing = existingIds[r.id];
    if (existing) {
      // Update only the head stats, not the body (prevents shifting)
      var head = existing.querySelector('.history-head');
      if (head) {
        var d = new Date(r.startedAt).toLocaleString();
        head.querySelector('.history-stats').innerHTML =
          '<span class="hs-ok">'+r.totalDone+' done</span>' +
          '<span class="hs-fail">'+r.totalFailed+' failed</span>' +
          '<span>/'+r.agentCount+' total</span>' +
          '<span style="color:var(--text-dim);margin-left:4px">'+fmtDuration(r)+'</span>';
      }
      delete existingIds[r.id];
    } else {
      var div = document.createElement('div');
      div.innerHTML = historyItemHTML(r, idx);
      list.appendChild(div.firstChild);
    }
  });
  // Remove items that are no longer active
  Object.values(existingIds).forEach(function(el) { el.remove(); });
}

function renderCompletedRuns() {
  var completed = historyRuns.filter(function(r) { return !!r.finishedAt; });
  var section = document.getElementById('history-completed-section');
  var list = document.getElementById('history-completed-list');
  if (!completed.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  completed.sort(function(a, b) {
    var va = histSortVal(a, histSortKey), vb = histSortVal(b, histSortKey);
    if (va < vb) return -1 * histSortDir;
    if (va > vb) return 1 * histSortDir;
    return 0;
  });
  list.innerHTML = completed.map(function(r) {
    return historyItemHTML(r, historyRuns.indexOf(r));
  }).join('');
}

function loadHistory() {
  fetch('/api/runs' + testTypeParam()).then(function(r){return r.json();}).then(function(runs) {
    var empty = document.getElementById('history-empty');
    if (!runs.length) {
      document.getElementById('history-active-section').style.display = 'none';
      document.getElementById('history-completed-section').style.display = 'none';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    historyRuns = runs;
    renderHistorySortBar();
    renderActiveRuns();
    renderCompletedRuns();
  });
}

function toggleHistory(idx, runId) {
  var body = document.getElementById('hb-' + idx);
  if (body.classList.contains('open')) { body.classList.remove('open'); return; }
  if (body.dataset.loaded) { body.classList.add('open'); return; }
  body.innerHTML = '<div class="history-body-inner"><div style="padding:8px;color:var(--text-dim)">Loading...</div></div>';
  body.classList.add('open');
  fetch('/api/runs/' + runId).then(function(r){return r.json();}).then(function(data) {
    body.dataset.loaded = '1';
    body.innerHTML = '<div class="history-body-inner">' + data.agents.map(function(r) {
      var cls = (r.status==='done'||r.status==='connected') ? 'ha-done' : 'ha-failed';
      var elapsed = r.finishedAt ? ((r.finishedAt - r.startedAt)/1000).toFixed(1) : '?';
      return '<div class="history-agent '+cls+'">' +
        '<div class="ha-header"><span class="ha-name">'+esc(r.username)+'</span>' +
        '<span class="badge badge-'+r.status+'">'+r.status+'</span></div>' +
        '<div class="ha-model">'+(function(){ var hmd=parseModelDisplay(r.model); return provBadge(hmd.prov)+esc(hmd.clean); })()+'</div>' +
        '<div class="ha-detail">' +
          (r.progress ? '<span style="color:var(--cyan)">'+r.progress.replace(/_/g,' ')+'</span> &middot; ' : '') +
          (r.gitlabUrl ? '<a href="'+r.gitlabUrl+'" target="_blank">'+esc(r.gitlabUrl)+'</a> &middot; ' : '') +
          elapsed+'s &middot; '+r.stepCount+' cmds' +
          (r.gameToken ? ' &middot; <span style="color:var(--green)">has token</span>' : '') +
          (r.error ? ' &middot; <span style="color:var(--red)">'+esc(r.error)+'</span>' : '') +
        '</div>' +
        '<span class="ha-msgs-toggle" data-agent="'+esc(r.id)+'" onclick="event.stopPropagation();toggleAgentMsgs(this)">Show messages</span>' +
        '<div class="ha-msgs" id="hm-'+esc(r.id)+'"></div></div>';
    }).join('') + '</div>';
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

var expData = [];

function patchExp(id, fields) {
  fields.id = id;
  fetch('/api/experiments', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(fields) });
}

function expDescBlur(el) {
  var id = parseInt(el.dataset.id);
  patchExp(id, { description: el.value });
  var row = expData.find(function(r) { return r.id === id; });
  if (row) row.description = el.value;
  el.style.borderColor = 'var(--green)';
  setTimeout(function() { el.style.borderColor = ''; }, 800);
}

function expStatusToggle(id) {
  var row = expData.find(function(r) { return r.id === id; });
  if (!row) return;
  var next = row.status === 'keep' ? 'discard' : row.status === 'discard' ? 'crash' : 'keep';
  row.status = next;
  patchExp(id, { status: next });
  renderExp();
}

function delExperiment(id) {
  if (!confirm('Delete experiment #' + id + '?')) return;
  fetch('/api/experiments', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id: id}) })
    .then(function() { loadExperiments(); });
}

function loadExperiments() {
  fetch('/api/experiments' + testTypeParam()).then(function(r){return r.json();}).then(function(rows) {
    expData = rows;
    renderExp();
  });
}

function renderExp() {
  var wrap = document.getElementById('exp-wrap');
  var empty = document.getElementById('exp-empty');
  if (!expData.length) { wrap.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';

  // Find best pass rate
  var best = 0;
  expData.forEach(function(r) { if (r.status === 'keep' && r.total > 0 && r.passed / r.total > best) best = r.passed / r.total; });

  var html = '<div class="summary-count"><strong>' + expData.length + '</strong> experiments</div>';
  html += '<table class="results-table"><thead><tr>';
  html += '<th>#</th><th>Commit</th><th>What Changed</th><th>Pass Rate</th><th>Status</th><th>Run</th><th>Date</th><th></th>';
  html += '</tr></thead><tbody>';

  expData.forEach(function(r, i) {
    var pct = r.total > 0 ? Math.round(r.passed / r.total * 100) : 0;
    var c = pct >= 80 ? 'var(--green)' : pct >= 40 ? 'var(--amber)' : 'var(--red)';
    if (r.status === 'crash') c = 'var(--red)';
    if (r.status === 'discard') c = 'var(--amber)';
    var isBest = r.status === 'keep' && r.total > 0 && r.passed / r.total === best && best > 0;
    var d = new Date(r.createdAt).toLocaleDateString();
    var statusCls = 'exp-status-' + r.status;
    var commitDisplay = r.commitHash ? esc(r.commitHash.substring(0, 7)) : '<span style="color:var(--text-muted)">--</span>';
    var rowStyle = r.status === 'discard' ? 'opacity:0.5;' : '';
    if (isBest) rowStyle += 'background:rgba(0,255,100,0.04);';

    html += '<tr style="'+rowStyle+'">' +
      '<td style="color:var(--text-dim)">'+(i+1)+'</td>' +
      '<td style="font-family:var(--mono);font-size:0.65rem;color:var(--cyan)">'+commitDisplay+'</td>' +
      '<td style="min-width:200px;max-width:360px"><input class="exp-input" value="'+esc(r.description)+'" placeholder="what changed\u2026" data-id="'+r.id+'" onblur="expDescBlur(this)" style="width:100%" /></td>' +
      '<td>' + (r.total > 0 ?
        '<div class="rate-bar"><div class="rate-bar-track"><div class="rate-bar-fill" style="width:'+pct+'%;background:'+c+'"></div></div>' +
        '<span class="rate-bar-pct" style="color:'+c+'">'+r.passed+'/'+r.total+'</span></div>' :
        '<span style="color:var(--text-muted)">--</span>') + '</td>' +
      '<td><span class="'+statusCls+'" style="font-size:0.65rem;font-weight:600;cursor:pointer" onclick="expStatusToggle('+r.id+')" title="Click to toggle">'+r.status+'</span></td>' +
      '<td style="font-size:0.62rem;color:var(--cyan)">'+(r.runId ? esc(r.runId) : '<span style="color:var(--text-muted)">--</span>')+'</td>' +
      '<td style="font-size:0.62rem;color:var(--text-dim)">'+d+'</td>' +
      '<td class="exp-row-actions"><button class="exp-action-btn" onclick="delExperiment('+r.id+')">del</button></td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
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
    const runTypes = Object.fromEntries(runTestTypeMap);
    res.write(`event: init\ndata: ${JSON.stringify({ agents: allAgents, progress, runTypes })}\n\n`);
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
      const testConfig = TEST_CONFIGS[body.test_type] || ACTIVE_TEST_CONFIG;
      const runId = await launchRun(count, model, testConfig);
      jsonRes(res, 200, { ok: true, runId, count, testType: testConfig.name });
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
      const testConfig = TEST_CONFIGS[body.test_type] || ACTIVE_TEST_CONFIG;
      const selectedModels: string[] | undefined = Array.isArray(body.models) ? body.models : undefined;
      const runId = await launchAllModels(concurrency, testConfig, selectedModels);
      const count = selectedModels ? selectedModels.length : TOOL_MODELS.length;
      jsonRes(res, 200, { ok: true, runId, modelCount: count, testType: testConfig.name });
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
    const raw = req.headers["content-length"] && Number(req.headers["content-length"]) > 0 ? await readBody(req) : "";
    const body = raw ? JSON.parse(raw) : {};
    const testConfig = TEST_CONFIGS[body.test_type] || ACTIVE_TEST_CONFIG;
    loopMode = true;
    emit("loop-status", { looping: true });
    if (activeRuns.size === 0) {
      const runId = await launchAllModels(5, testConfig);
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
    const testTypeFilter = url.searchParams.get("test_type") || undefined;
    jsonRes(res, 200, listRuns(50, testTypeFilter));
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
    const testTypeFilter = url.searchParams.get("test_type") || undefined;
    const stats = listModelStats(testTypeFilter);
    const progressMap = listProgressBreakdown(testTypeFilter);
    const paramMapLocal: Record<string, number | null> = {};
    TOOL_MODELS.forEach(function(m) { paramMapLocal[m.displayId] = m.active_params_b; });
    const enriched = stats.map(function(s) {
      return { ...s, params: paramMapLocal[s.model] || null, progressBreakdown: progressMap[s.model] || {} };
    });
    jsonRes(res, 200, enriched);
    return;
  }

  if (url.pathname === "/api/models" && req.method === "GET") {
    jsonRes(res, 200, TOOL_MODELS);
    return;
  }

  if (url.pathname === "/api/experiments" && req.method === "GET") {
    const testTypeFilter = url.searchParams.get("test_type") || undefined;
    const rows = listExperiments(testTypeFilter);
    jsonRes(res, 200, rows);
    return;
  }

  if (url.pathname === "/api/experiments" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    const id = insertExperiment({
      commitHash: body.commit_hash || undefined,
      testType: body.test_type || ACTIVE_TEST_CONFIG.name,
      description: body.description || "",
      status: body.status || "keep",
      passRate: body.pass_rate || undefined,
      passed: body.passed || 0,
      failed: body.failed || 0,
      total: body.total || 0,
      runId: body.run_id || undefined,
    });
    jsonRes(res, 200, { ok: true, id });
    return;
  }

  if (url.pathname === "/api/experiments" && req.method === "PUT") {
    const body = JSON.parse(await readBody(req));
    if (!body.id) { jsonRes(res, 400, { error: "id required" }); return; }
    updateExperiment(body.id, {
      commitHash: body.commit_hash,
      description: body.description,
      status: body.status,
      passRate: body.pass_rate,
      passed: body.passed,
      failed: body.failed,
      total: body.total,
      runId: body.run_id,
    });
    jsonRes(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/experiments" && req.method === "DELETE") {
    const body = JSON.parse(await readBody(req));
    if (!body.id) { jsonRes(res, 400, { error: "id required" }); return; }
    deleteExperiment(body.id);
    jsonRes(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/completed-runs" && req.method === "GET") {
    const testTypeFilter = url.searchParams.get("test_type") || undefined;
    const runs = listRuns(100, testTypeFilter).filter(r => r.finishedAt);
    const rows = runs.map((r) => ({
      id: r.id,
      test_type: r.testType,
      pass_rate: r.totalDone + "/" + r.agentCount,
      passed: r.totalDone,
      failed: r.totalFailed,
      total: r.agentCount,
      date: new Date(r.startedAt).toISOString(),
    }));
    jsonRes(res, 200, rows);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ── Main ────────────────────────────────────────────────────

async function main() {
  const dbPath = resolve(__dirname, "../pi-test-results.db");
  initDb(dbPath);
  migrateSchema();
  console.log(`  DB: ${dbPath}`);

  const orphaned = cleanupOrphanedRuns();
  if (orphaned > 0) console.log(`  Cleaned up ${orphaned} orphaned run(s).`);

  const nimCount = TOOL_MODELS.filter(m => m.testProvider === "nim").length;
  const hfCount = TOOL_MODELS.filter(m => m.testProvider === "hf").length;
  console.log(`  ${TOOL_MODELS.length} models loaded (${nimCount} NIM, ${hfCount} HF). Provider: ${ACTIVE_PROVIDER}`);
  console.log(`  Test type: ${ACTIVE_TEST_CONFIG.name}`);

  httpServer.listen(DASHBOARD_PORT, () => {
    console.log(`\n  Pi Agent Test Lab — http://localhost:${DASHBOARD_PORT}/\n`);
  });

  if (AUTO_ALL) {
    console.log(`  Auto-launching all ${TOOL_MODELS.length} models (${ACTIVE_TEST_CONFIG.name})...`);
    await launchAllModels(5, ACTIVE_TEST_CONFIG);
  }
}

main();
