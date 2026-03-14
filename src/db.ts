/**
 * SQLite persistence for CLI Test Dashboard.
 * Uses better-sqlite3 for synchronous, crash-safe local storage.
 */

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let db: Database.Database;

// ── Schema ──────────────────────────────────────────────────

const SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;

  CREATE TABLE IF NOT EXISTS runs (
    id            TEXT PRIMARY KEY,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    game_server   TEXT NOT NULL,
    model_filter  TEXT,
    agent_count   INTEGER NOT NULL,
    total_done    INTEGER NOT NULL DEFAULT 0,
    total_failed  INTEGER NOT NULL DEFAULT 0,
    test_type     TEXT NOT NULL DEFAULT 'apocalypse-radio',
    notes         TEXT
  );

  CREATE TABLE IF NOT EXISTS agents (
    id            TEXT PRIMARY KEY,
    run_id        TEXT NOT NULL REFERENCES runs(id),
    username      TEXT NOT NULL,
    email         TEXT NOT NULL,
    model         TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'starting',
    error         TEXT,
    gitlab_url    TEXT,
    game_token    TEXT,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    step_count    INTEGER NOT NULL DEFAULT 0,
    progress      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agents_run ON agents(run_id);
  CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  CREATE INDEX IF NOT EXISTS idx_agents_gitlab ON agents(gitlab_url);

  CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id      TEXT NOT NULL REFERENCES agents(id),
    role          TEXT NOT NULL,
    content       TEXT NOT NULL,
    timestamp     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);

  CREATE TABLE IF NOT EXISTS experiments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    commit_hash   TEXT,
    test_type     TEXT NOT NULL DEFAULT 'apocalypse-radio',
    description   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'keep',
    pass_rate     TEXT,
    passed        INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0,
    total         INTEGER NOT NULL DEFAULT 0,
    run_id        TEXT REFERENCES runs(id),
    created_at    INTEGER NOT NULL
  );
`;

// ── Init ────────────────────────────────────────────────────

export function initDb(dbPath: string): void {
  db = new Database(dbPath);
  db.exec(SCHEMA);
}

// ── Writes ──────────────────────────────────────────────────

export function insertRun(run: {
  id: string;
  gameServer: string;
  modelFilter: string;
  agentCount: number;
  startedAt: number;
  testType?: string;
}): void {
  db.prepare(
    `INSERT INTO runs (id, started_at, game_server, model_filter, agent_count, test_type) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(run.id, run.startedAt, run.gameServer, run.modelFilter, run.agentCount, run.testType || "apocalypse-radio");
}

export function finishRun(runId: string): void {
  const counts = db.prepare(
    `SELECT
       SUM(CASE WHEN status IN ('done','connected') THEN 1 ELSE 0 END) as done,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM agents WHERE run_id = ?`,
  ).get(runId) as { done: number; failed: number };

  db.prepare(
    `UPDATE runs SET finished_at = ?, total_done = ?, total_failed = ? WHERE id = ?`,
  ).run(Date.now(), counts.done || 0, counts.failed || 0, runId);
}

export function updateRunNotes(runId: string, notes: string): void {
  db.prepare(`UPDATE runs SET notes = ? WHERE id = ?`).run(notes, runId);
}

/** Mark orphaned runs (no finished_at) and their stuck agents as finished */
export function cleanupOrphanedRuns(): number {
  const orphaned = db.prepare(`SELECT id FROM runs WHERE finished_at IS NULL`).all() as { id: string }[];
  for (const { id } of orphaned) {
    // Mark stuck agents as failed
    db.prepare(`UPDATE agents SET status = 'failed', error = 'Orphaned (process restarted)', finished_at = ? WHERE run_id = ? AND status NOT IN ('done', 'failed')`).run(Date.now(), id);
    finishRun(id);
  }
  return orphaned.length;
}

export function insertAgent(agent: {
  id: string;
  runId: string;
  username: string;
  email: string;
  model: string;
  startedAt: number;
}): void {
  db.prepare(
    `INSERT INTO agents (id, run_id, username, email, model, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agent.id, agent.runId, agent.username, agent.email, agent.model, agent.startedAt);
}

export function updateAgentStatus(agentId: string, status: string, error?: string): void {
  if (["done", "connected", "failed"].includes(status)) {
    db.prepare(
      `UPDATE agents SET status = ?, error = ?, finished_at = ? WHERE id = ?`,
    ).run(status, error || null, Date.now(), agentId);
  } else {
    db.prepare(`UPDATE agents SET status = ?, error = ? WHERE id = ?`).run(
      status,
      error || null,
      agentId,
    );
  }
}

export function updateAgentGitlab(agentId: string, gitlabUrl: string): void {
  db.prepare(`UPDATE agents SET gitlab_url = ? WHERE id = ?`).run(gitlabUrl, agentId);
}

export function updateAgentGameToken(agentId: string, gameToken: string): void {
  db.prepare(`UPDATE agents SET game_token = ? WHERE id = ?`).run(gameToken, agentId);
}

export function incrementAgentSteps(agentId: string): void {
  db.prepare(`UPDATE agents SET step_count = step_count + 1 WHERE id = ?`).run(agentId);
}

export function updateAgentProgress(agentId: string, progress: string): void {
  db.prepare(`UPDATE agents SET progress = ? WHERE id = ?`).run(progress, agentId);
}

export function insertMessage(msg: {
  agentId: string;
  role: string;
  content: string;
  timestamp: number;
}): void {
  db.prepare(
    `INSERT INTO messages (agent_id, role, content, timestamp) VALUES (?, ?, ?, ?)`,
  ).run(msg.agentId, msg.role, msg.content, msg.timestamp);
}

// ── Reads ───────────────────────────────────────────────────

export interface RunSummary {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  gameServer: string;
  modelFilter: string | null;
  agentCount: number;
  totalDone: number;
  totalFailed: number;
  testType: string;
  notes: string | null;
}

export function listRuns(limit = 50, testType?: string): RunSummary[] {
  const query = testType
    ? `SELECT * FROM runs WHERE test_type = ? ORDER BY started_at DESC LIMIT ?`
    : `SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`;
  const params = testType ? [testType, limit] : [limit];
  return (
    db
      .prepare(query)
      .all(...params) as {
      id: string;
      started_at: number;
      finished_at: number | null;
      game_server: string;
      model_filter: string | null;
      agent_count: number;
      total_done: number;
      total_failed: number;
      test_type: string;
      notes: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    gameServer: r.game_server,
    modelFilter: r.model_filter,
    agentCount: r.agent_count,
    totalDone: r.total_done,
    totalFailed: r.total_failed,
    testType: r.test_type,
    notes: r.notes,
  }));
}

export interface AgentRow {
  id: string;
  runId: string;
  username: string;
  email: string;
  model: string;
  status: string;
  error: string | null;
  gitlabUrl: string | null;
  gameToken: string | null;
  startedAt: number;
  finishedAt: number | null;
  stepCount: number;
  progress: string | null;
}

function mapAgent(r: Record<string, unknown>): AgentRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    username: r.username as string,
    email: r.email as string,
    model: r.model as string,
    status: r.status as string,
    error: r.error as string | null,
    gitlabUrl: r.gitlab_url as string | null,
    gameToken: r.game_token as string | null,
    startedAt: r.started_at as number,
    finishedAt: r.finished_at as number | null,
    stepCount: r.step_count as number,
    progress: r.progress as string | null,
  };
}

export function getAgentsForRun(runId: string): AgentRow[] {
  return (db.prepare(`SELECT * FROM agents WHERE run_id = ? ORDER BY id`).all(runId) as Record<string, unknown>[]).map(mapAgent);
}

export function getAgent(agentId: string): AgentRow | undefined {
  const r = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId) as Record<string, unknown> | undefined;
  return r ? mapAgent(r) : undefined;
}

export interface MessageRow {
  id: number;
  agentId: string;
  role: string;
  content: string;
  timestamp: number;
}

export function getMessagesForAgent(agentId: string): MessageRow[] {
  return (
    db
      .prepare(`SELECT * FROM messages WHERE agent_id = ? ORDER BY id`)
      .all(agentId) as { id: number; agent_id: string; role: string; content: string; timestamp: number }[]
  ).map((m) => ({
    id: m.id,
    agentId: m.agent_id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
  }));
}

export interface RegisteredAgentRow {
  username: string;
  gitlabUrl: string;
  model: string;
  status: string;
  runId: string;
  startedAt: number;
  gameToken: string | null;
  stepCount: number;
}

export function listRegisteredAgents(): RegisteredAgentRow[] {
  return (
    db
      .prepare(
        `SELECT username, gitlab_url, model, status, run_id, started_at, game_token, step_count
         FROM agents WHERE gitlab_url IS NOT NULL
         ORDER BY started_at DESC`,
      )
      .all() as Record<string, unknown>[]
  ).map((r) => ({
    username: r.username as string,
    gitlabUrl: r.gitlab_url as string,
    model: r.model as string,
    status: r.status as string,
    runId: r.run_id as string,
    startedAt: r.started_at as number,
    gameToken: r.game_token as string | null,
    stepCount: r.step_count as number,
  }));
}

export interface ModelStats {
  model: string;
  total: number;
  done: number;
  failed: number;
  registered: number;
  authed: number;
  avgSteps: number;
  avgElapsed: number;
}

// ── Schema migrations ───────────────────────────────────────

export function migrateSchema(): void {
  // Add test_type column if it doesn't exist (for existing DBs)
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "test_type")) {
    db.exec(`ALTER TABLE runs ADD COLUMN test_type TEXT NOT NULL DEFAULT 'apocalypse-radio'`);
  }
  if (!cols.some((c) => c.name === "notes")) {
    db.exec(`ALTER TABLE runs ADD COLUMN notes TEXT`);
  }
  const agentCols = db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[];
  if (!agentCols.some((c) => c.name === "progress")) {
    db.exec(`ALTER TABLE agents ADD COLUMN progress TEXT`);
  }
}

export function listModelStats(testType?: string): ModelStats[] {
  const whereClause = testType
    ? `WHERE a.run_id IN (SELECT id FROM runs WHERE test_type = ?)`
    : ``;
  const params = testType ? [testType] : [];
  return (
    db
      .prepare(
        `SELECT
           a.model,
           COUNT(*) as total,
           SUM(CASE WHEN a.status IN ('done','connected') THEN 1 ELSE 0 END) as done,
           SUM(CASE WHEN a.status = 'failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN a.gitlab_url IS NOT NULL THEN 1 ELSE 0 END) as registered,
           SUM(CASE WHEN a.game_token IS NOT NULL THEN 1 ELSE 0 END) as authed,
           AVG(a.step_count) as avg_steps,
           AVG(CASE WHEN a.finished_at IS NOT NULL THEN (a.finished_at - a.started_at) / 1000.0 ELSE NULL END) as avg_elapsed
         FROM agents a
         ${whereClause}
         GROUP BY a.model
         ORDER BY total DESC`,
      )
      .all(...params) as Record<string, unknown>[]
  ).map((r) => ({
    model: r.model as string,
    total: r.total as number,
    done: r.done as number,
    failed: r.failed as number,
    registered: r.registered as number,
    authed: r.authed as number,
    avgSteps: Math.round((r.avg_steps as number) * 10) / 10,
    avgElapsed: Math.round((r.avg_elapsed as number || 0) * 10) / 10,
  }));
}

export function listProgressBreakdown(testType?: string): Record<string, Record<string, number>> {
  const whereClause = testType
    ? `WHERE a.run_id IN (SELECT id FROM runs WHERE test_type = ?)`
    : ``;
  const params = testType ? [testType] : [];
  const rows = db.prepare(
    `SELECT a.model, COALESCE(a.progress, 'none') as progress, COUNT(*) as cnt
     FROM agents a ${whereClause}
     GROUP BY a.model, a.progress
     ORDER BY a.model`,
  ).all(...params) as { model: string; progress: string; cnt: number }[];

  const result: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    if (!result[r.model]) result[r.model] = {};
    result[r.model][r.progress] = r.cnt;
  }
  return result;
}

// ── Experiments ──────────────────────────────────────────────

export interface ExperimentRow {
  id: number;
  commitHash: string | null;
  testType: string;
  description: string;
  status: string;
  passRate: string | null;
  passed: number;
  failed: number;
  total: number;
  runId: string | null;
  createdAt: number;
}

export function insertExperiment(exp: {
  commitHash?: string;
  testType: string;
  description: string;
  status?: string;
  passRate?: string;
  passed?: number;
  failed?: number;
  total?: number;
  runId?: string;
}): number {
  const result = db.prepare(
    `INSERT INTO experiments (commit_hash, test_type, description, status, pass_rate, passed, failed, total, run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    exp.commitHash || null, exp.testType, exp.description, exp.status || "keep",
    exp.passRate || null, exp.passed || 0, exp.failed || 0, exp.total || 0,
    exp.runId || null, Date.now(),
  );
  return Number(result.lastInsertRowid);
}

export function updateExperiment(id: number, fields: {
  commitHash?: string;
  description?: string;
  status?: string;
  passRate?: string;
  passed?: number;
  failed?: number;
  total?: number;
  runId?: string;
}): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.commitHash !== undefined) { sets.push("commit_hash = ?"); vals.push(fields.commitHash); }
  if (fields.description !== undefined) { sets.push("description = ?"); vals.push(fields.description); }
  if (fields.status !== undefined) { sets.push("status = ?"); vals.push(fields.status); }
  if (fields.passRate !== undefined) { sets.push("pass_rate = ?"); vals.push(fields.passRate); }
  if (fields.passed !== undefined) { sets.push("passed = ?"); vals.push(fields.passed); }
  if (fields.failed !== undefined) { sets.push("failed = ?"); vals.push(fields.failed); }
  if (fields.total !== undefined) { sets.push("total = ?"); vals.push(fields.total); }
  if (fields.runId !== undefined) { sets.push("run_id = ?"); vals.push(fields.runId); }
  if (!sets.length) return;
  vals.push(id);
  db.prepare(`UPDATE experiments SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function deleteExperiment(id: number): void {
  db.prepare(`DELETE FROM experiments WHERE id = ?`).run(id);
}

export function listExperiments(testType?: string): ExperimentRow[] {
  const query = testType
    ? `SELECT * FROM experiments WHERE test_type = ? ORDER BY id ASC`
    : `SELECT * FROM experiments ORDER BY id ASC`;
  const params = testType ? [testType] : [];
  return (db.prepare(query).all(...params) as Record<string, unknown>[]).map((r) => ({
    id: r.id as number,
    commitHash: r.commit_hash as string | null,
    testType: r.test_type as string,
    description: r.description as string,
    status: r.status as string,
    passRate: r.pass_rate as string | null,
    passed: r.passed as number,
    failed: r.failed as number,
    total: r.total as number,
    runId: r.run_id as string | null,
    createdAt: r.created_at as number,
  }));
}

// ── Migration from JSON logs ────────────────────────────────

export function migrateJsonLogs(logsDir: string): number {
  const runCount = (db.prepare(`SELECT COUNT(*) as c FROM runs`).get() as { c: number }).c;
  if (runCount > 0) return 0; // already have data

  let files: string[];
  try {
    files = readdirSync(logsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return 0;
  }
  if (!files.length) return 0;

  const migrate = db.transaction(() => {
    let migrated = 0;
    for (const file of files) {
      try {
        const log = JSON.parse(readFileSync(resolve(logsDir, file), "utf-8"));
        const runId = log.runId || file.replace(".json", "");
        const ts = log.timestamp ? new Date(log.timestamp).getTime() : Date.now();
        const summary = log.summary || {};

        db.prepare(
          `INSERT OR IGNORE INTO runs (id, started_at, finished_at, game_server, model_filter, agent_count, total_done, total_failed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(runId, ts, ts, log.gameServer || "unknown", "unknown", log.agentCount || 0, summary.done || 0, summary.failed || 0);

        for (const r of log.results || []) {
          const rawId = r.id || r.username || "unknown";
          const agentId = rawId.startsWith(runId) ? rawId : `${runId}-${rawId}`;
          const startedAt = ts - (r.elapsed || 0) * 1000;

          db.prepare(
            `INSERT OR IGNORE INTO agents (id, run_id, username, email, model, status, error, gitlab_url, game_token, started_at, finished_at, step_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            agentId, runId, r.username || "unknown", r.email || "unknown",
            r.model || "unknown", r.status || "unknown", r.error || null,
            r.gitlabUrl || null, r.gameToken || null,
            startedAt, ts, r.steps || 0,
          );

          for (const m of r.messages || []) {
            db.prepare(
              `INSERT INTO messages (agent_id, role, content, timestamp) VALUES (?, ?, ?, ?)`,
            ).run(agentId, m.role, m.content, m.timestamp || ts);
          }
        }
        migrated++;
      } catch (err) {
        console.error(`  Migration error for ${file}:`, (err as Error).message);
      }
    }
    return migrated;
  });

  return migrate();
}
