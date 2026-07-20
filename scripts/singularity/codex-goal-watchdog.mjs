#!/usr/bin/env node

import { spawnSync as defaultSpawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const CONTINUE_PROMPT = "请先核对当前目标、最新用户要求和工作区状态，然后从未完成处继续；不要重复已完成工作。";

const COMPONENT = "codex-goal-watchdog";
const DEFAULT_SILENT_MINUTES = 15;
const BACKOFF_VERSION = 1;
const INITIAL_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 3_600_000;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_ID_PATTERN = /^call_[A-Za-z0-9_-]{24}$/;
const RECOGNIZED_ABORT_REASONS = new Set(["interrupted"]);
const TOOL_CALL_OUTPUTS = new Map([
  ["function_call", "function_call_output"],
  ["custom_tool_call", "custom_tool_call_output"],
  ["tool_search_call", "tool_search_output"],
]);
const OUTPUT_TOOL_CALLS = new Map([...TOOL_CALL_OUTPUTS].map(([call, output]) => [output, call]));

const EXPECTED_SCHEMAS = {
  thread_goals: [
    ["thread_id", "TEXT", 1, null, 1],
    ["goal_id", "TEXT", 1, null, 0],
    ["objective", "TEXT", 1, null, 0],
    ["status", "TEXT", 1, null, 0],
    ["token_budget", "INTEGER", 0, null, 0],
    ["tokens_used", "INTEGER", 1, "0", 0],
    ["time_used_seconds", "INTEGER", 1, "0", 0],
    ["created_at_ms", "INTEGER", 1, null, 0],
    ["updated_at_ms", "INTEGER", 1, null, 0],
  ],
  threads: [
    ["id", "TEXT", 0, null, 1],
    ["rollout_path", "TEXT", 1, null, 0],
    ["created_at", "INTEGER", 1, null, 0],
    ["updated_at", "INTEGER", 1, null, 0],
    ["source", "TEXT", 1, null, 0],
    ["model_provider", "TEXT", 1, null, 0],
    ["cwd", "TEXT", 1, null, 0],
    ["title", "TEXT", 1, null, 0],
    ["sandbox_policy", "TEXT", 1, null, 0],
    ["approval_mode", "TEXT", 1, null, 0],
    ["tokens_used", "INTEGER", 1, "0", 0],
    ["has_user_event", "INTEGER", 1, "0", 0],
    ["archived", "INTEGER", 1, "0", 0],
    ["archived_at", "INTEGER", 0, null, 0],
    ["git_sha", "TEXT", 0, null, 0],
    ["git_branch", "TEXT", 0, null, 0],
    ["git_origin_url", "TEXT", 0, null, 0],
    ["cli_version", "TEXT", 1, "''", 0],
    ["first_user_message", "TEXT", 1, "''", 0],
    ["agent_nickname", "TEXT", 0, null, 0],
    ["agent_role", "TEXT", 0, null, 0],
    ["memory_mode", "TEXT", 1, "'enabled'", 0],
    ["model", "TEXT", 0, null, 0],
    ["reasoning_effort", "TEXT", 0, null, 0],
    ["agent_path", "TEXT", 0, null, 0],
    ["created_at_ms", "INTEGER", 0, null, 0],
    ["updated_at_ms", "INTEGER", 0, null, 0],
    ["thread_source", "TEXT", 0, null, 0],
    ["preview", "TEXT", 1, "''", 0],
    ["recency_at", "INTEGER", 1, "0", 0],
    ["recency_at_ms", "INTEGER", 1, "0", 0],
    ["history_mode", "TEXT", 1, "'legacy'", 0],
  ],
};

class WatchdogError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "WatchdogError";
    this.reason = reason;
  }
}

function reasonFor(error) {
  return error instanceof WatchdogError ? error.reason : "internal_error";
}

function defaultLogger(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function emit(logger, event, fields = {}) {
  logger({
    component: COMPONENT,
    event,
    ...fields,
  });
}

function threadReference(threadId) {
  return createHash("sha256").update(threadId).digest("hex").slice(0, 12);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isPathWithin(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function databaseSchema(database, table) {
  return database.prepare(`PRAGMA table_info("${table}")`).all().map((column) => [
    column.name,
    column.type,
    column.notnull,
    column.dflt_value,
    column.pk,
  ]);
}

function assertDatabaseSchema(database, table) {
  const actual = databaseSchema(database, table);
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_SCHEMAS[table])) {
    throw new WatchdogError("schema_mismatch");
  }
}

function openSources(codexHome) {
  let goalsDatabase;
  let stateDatabase;
  try {
    goalsDatabase = new DatabaseSync(join(codexHome, "goals_1.sqlite"), { readOnly: true });
    stateDatabase = new DatabaseSync(join(codexHome, "state_5.sqlite"), { readOnly: true });
    assertDatabaseSchema(goalsDatabase, "thread_goals");
    assertDatabaseSchema(stateDatabase, "threads");
    return { goalsDatabase, stateDatabase };
  } catch (error) {
    goalsDatabase?.close();
    stateDatabase?.close();
    if (error instanceof WatchdogError) {
      throw error;
    }
    throw new WatchdogError("source_unavailable");
  }
}

function closeSources(sources) {
  sources.goalsDatabase.close();
  sources.stateDatabase.close();
}

function parseEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw new WatchdogError("rollout_invalid");
  }
  if (!isObject(event) || typeof event.type !== "string") {
    throw new WatchdogError("rollout_invalid");
  }
  return event;
}

function validTurnEvent(payload) {
  return isObject(payload) && THREAD_ID_PATTERN.test(payload.turn_id);
}

function recordToolEvent(turn, payload) {
  if (!isObject(payload) || typeof payload.type !== "string") {
    throw new WatchdogError("tool_schema_unknown");
  }

  const expectedOutput = TOOL_CALL_OUTPUTS.get(payload.type);
  if (expectedOutput !== undefined) {
    if (!CALL_ID_PATTERN.test(payload.call_id) || turn.terminal !== null || turn.calls.has(payload.call_id)) {
      throw new WatchdogError("tool_schema_unknown");
    }
    turn.calls.set(payload.call_id, expectedOutput);
    return;
  }

  const expectedCall = OUTPUT_TOOL_CALLS.get(payload.type);
  if (expectedCall !== undefined) {
    if (!CALL_ID_PATTERN.test(payload.call_id) || turn.terminal !== null) {
      throw new WatchdogError("tool_schema_unknown");
    }
    const registeredOutput = turn.calls.get(payload.call_id);
    if (registeredOutput !== payload.type) {
      throw new WatchdogError("tool_schema_unknown");
    }
    turn.calls.delete(payload.call_id);
    return;
  }

  if (payload.type.includes("call")) {
    throw new WatchdogError("tool_schema_unknown");
  }
}

export async function inspectRollout(rolloutPath) {
  let latestTurn = null;
  const input = createReadStream(rolloutPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const line of lines) {
      if (line === "") {
        continue;
      }
      const event = parseEvent(line);
      if (event.type === "event_msg") {
        if (!isObject(event.payload) || typeof event.payload.type !== "string") {
          throw new WatchdogError("lifecycle_unrecognized");
        }
        if (event.payload.type === "task_started") {
          if (!validTurnEvent(event.payload)) {
            throw new WatchdogError("lifecycle_unrecognized");
          }
          latestTurn = {
            calls: new Map(),
            terminal: null,
            turnId: event.payload.turn_id,
          };
          continue;
        }
        if (event.payload.type === "task_complete" || event.payload.type === "turn_aborted") {
          if (
            latestTurn === null
            || !validTurnEvent(event.payload)
            || event.payload.turn_id !== latestTurn.turnId
            || latestTurn.terminal !== null
          ) {
            throw new WatchdogError("lifecycle_unrecognized");
          }
          if (
            event.payload.type === "turn_aborted"
            && !RECOGNIZED_ABORT_REASONS.has(event.payload.reason)
          ) {
            throw new WatchdogError("lifecycle_unrecognized");
          }
          latestTurn.terminal = event.payload.type;
          continue;
        }
      }

      if (event.type === "response_item" && latestTurn !== null) {
        recordToolEvent(latestTurn, event.payload);
      }
    }
  } catch (error) {
    input.destroy();
    if (error instanceof WatchdogError) {
      return { eligible: false, reason: error.reason };
    }
    return { eligible: false, reason: "rollout_unreadable" };
  }

  if (latestTurn === null || latestTurn.terminal === null) {
    return { eligible: false, reason: "lifecycle_unrecognized" };
  }
  if (latestTurn.calls.size > 0) {
    return { eligible: false, reason: "tool_incomplete" };
  }
  if (latestTurn.terminal === "task_complete") {
    return { eligible: false, reason: "turn_complete" };
  }
  return { eligible: true };
}

function incrementReason(reasons, reason) {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function readThread(stateDatabase, threadId) {
  return stateDatabase.prepare(`
    SELECT id, rollout_path, archived, updated_at_ms
    FROM threads
    WHERE id = ?
  `).get(threadId);
}

async function evaluateGoal(goal, stateDatabase, sessionsRoot, nowMs, silentMs) {
  if (!THREAD_ID_PATTERN.test(goal.thread_id) || !isPositiveSafeInteger(goal.updated_at_ms)) {
    return { eligible: false, reason: "identity_invalid" };
  }

  const thread = readThread(stateDatabase, goal.thread_id);
  if (thread === undefined) {
    return { eligible: false, reason: "thread_missing" };
  }
  if (thread.archived !== 0) {
    return { eligible: false, reason: "thread_archived" };
  }
  if (
    thread.id !== goal.thread_id
    || typeof thread.rollout_path !== "string"
    || !isPositiveSafeInteger(thread.updated_at_ms)
  ) {
    return { eligible: false, reason: "identity_invalid" };
  }

  let rolloutPath;
  let rolloutStat;
  try {
    rolloutPath = realpathSync(thread.rollout_path);
    rolloutStat = statSync(rolloutPath);
  } catch {
    return { eligible: false, reason: "rollout_unreadable" };
  }
  if (!rolloutStat.isFile() || !isPathWithin(sessionsRoot, rolloutPath)) {
    return { eligible: false, reason: "rollout_path_invalid" };
  }

  const activityAtMs = Math.max(goal.updated_at_ms, thread.updated_at_ms, Math.trunc(rolloutStat.mtimeMs));
  if (!isPositiveSafeInteger(activityAtMs) || nowMs - activityAtMs < silentMs) {
    return { eligible: false, reason: "not_silent" };
  }

  const lifecycle = await inspectRollout(rolloutPath);
  if (!lifecycle.eligible) {
    return lifecycle;
  }

  return {
    eligible: true,
    candidate: {
      activityAtMs,
      goalUpdatedAtMs: goal.updated_at_ms,
      rolloutMtimeMs: rolloutStat.mtimeMs,
      rolloutPath,
      rolloutSize: rolloutStat.size,
      threadId: goal.thread_id,
      threadUpdatedAtMs: thread.updated_at_ms,
    },
  };
}

async function scanSources(sources, codexHome, nowMs, silentMs) {
  let sessionsRoot;
  try {
    sessionsRoot = realpathSync(join(codexHome, "sessions"));
  } catch {
    throw new WatchdogError("sessions_unavailable");
  }

  let goals;
  try {
    goals = sources.goalsDatabase.prepare(`
      SELECT thread_id, updated_at_ms
      FROM thread_goals
      WHERE status = ?
      ORDER BY updated_at_ms DESC, thread_id ASC
    `).all("active");
  } catch {
    throw new WatchdogError("source_unavailable");
  }

  const candidates = [];
  const rejected = {};
  for (const goal of goals) {
    const result = await evaluateGoal(goal, sources.stateDatabase, sessionsRoot, nowMs, silentMs);
    if (result.eligible) {
      candidates.push(result.candidate);
    } else {
      incrementReason(rejected, result.reason);
    }
  }
  candidates.sort((left, right) => right.activityAtMs - left.activityAtMs);
  return {
    active: goals.length,
    candidates,
    rejected,
  };
}

function readBackoff(backoffPath) {
  if (!existsSync(backoffPath)) {
    return { failures: 0, nextAttemptAtMs: 0, version: BACKOFF_VERSION };
  }

  let state;
  try {
    state = JSON.parse(readFileSync(backoffPath, "utf8"));
  } catch {
    throw new WatchdogError("backoff_invalid");
  }
  if (
    !isObject(state)
    || JSON.stringify(Object.keys(state).sort()) !== JSON.stringify(["failures", "nextAttemptAtMs", "version"])
    || state.version !== BACKOFF_VERSION
    || !isPositiveSafeInteger(state.failures)
    || !isPositiveSafeInteger(state.nextAttemptAtMs)
  ) {
    throw new WatchdogError("backoff_invalid");
  }
  return state;
}

function writeBackoff(stateDir, backoffPath, state) {
  const temporaryPath = join(stateDir, `.backoff-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, backoffPath);
  } catch {
    rmSync(temporaryPath, { force: true });
    throw new WatchdogError("backoff_write_failed");
  }
}

function nextBackoff(previous, nowMs) {
  const failures = previous.failures + 1;
  const exponent = Math.min(failures - 1, 30);
  const delayMs = Math.min(INITIAL_BACKOFF_MS * (2 ** exponent), MAX_BACKOFF_MS);
  return {
    failures,
    nextAttemptAtMs: nowMs + delayMs,
    version: BACKOFF_VERSION,
  };
}

function acquireLock(stateDir, lockPath) {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      return null;
    }
    throw new WatchdogError("lock_error");
  }
  return () => {
    try {
      // 并发锁以空目录表示占用，释放时只能删除该目录，不能把文件删除语义混用进来。
      rmdirSync(lockPath);
    } catch {
      throw new WatchdogError("lock_release_failed");
    }
  };
}

function revalidateCandidate(candidate, sources) {
  let goal;
  let thread;
  let rolloutStat;
  try {
    goal = sources.goalsDatabase.prepare(`
      SELECT status, updated_at_ms
      FROM thread_goals
      WHERE thread_id = ?
    `).get(candidate.threadId);
    thread = readThread(sources.stateDatabase, candidate.threadId);
    rolloutStat = statSync(candidate.rolloutPath);
  } catch {
    return false;
  }

  return goal?.status === "active"
    && goal.updated_at_ms === candidate.goalUpdatedAtMs
    && thread?.id === candidate.threadId
    && thread.archived === 0
    && thread.updated_at_ms === candidate.threadUpdatedAtMs
    && realpathSync(thread.rollout_path) === candidate.rolloutPath
    && rolloutStat.isFile()
    && rolloutStat.size === candidate.rolloutSize
    && rolloutStat.mtimeMs === candidate.rolloutMtimeMs;
}

function validateRuntimeOptions(options) {
  const silentMinutes = options.silentMinutes ?? DEFAULT_SILENT_MINUTES;
  const silentMs = silentMinutes * 60_000;
  if (
    typeof options.execute !== "boolean"
    || !isPositiveSafeInteger(silentMinutes)
    || !isPositiveSafeInteger(silentMs)
  ) {
    throw new WatchdogError("invalid_arguments");
  }
  return {
    execute: options.execute,
    silentMs,
    silentMinutes,
  };
}

function defaultCodexHome() {
  return resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
}

function defaultStateDir() {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return resolve(stateHome, "singularity", COMPONENT);
}

function assertIndependentStateDir(codexHome, stateDir) {
  if (resolve(codexHome) === resolve(stateDir) || isPathWithin(resolve(codexHome), resolve(stateDir))) {
    throw new WatchdogError("state_dir_invalid");
  }
}

function assertNode24(version) {
  if (typeof version !== "string" || !/^24[.]/.test(version)) {
    throw new WatchdogError("node_version_unsupported");
  }
}

function scanLogFields(mode, scan, silentMinutes, selected, action) {
  return {
    action,
    active: scan.active,
    eligible: scan.candidates.length,
    mode,
    rejected: scan.rejected,
    selected: selected === undefined ? null : threadReference(selected.threadId),
    silentMinutes,
  };
}

export async function runWatchdog(options, dependencies = {}) {
  const logger = dependencies.log ?? defaultLogger;
  let runtime;
  try {
    runtime = validateRuntimeOptions(options);
  } catch (error) {
    emit(logger, "blocked", { mode: "unknown", reason: reasonFor(error) });
    return { exitCode: 2, outcome: "blocked" };
  }

  const mode = runtime.execute ? "execute" : "dry-run";
  const now = dependencies.now ?? Date.now;
  const nowMs = now();
  const codexHome = resolve(dependencies.codexHome ?? defaultCodexHome());
  const stateDir = resolve(dependencies.stateDir ?? defaultStateDir());
  const lockPath = join(stateDir, "run.lock");
  const backoffPath = join(stateDir, "backoff.json");
  const spawnSync = dependencies.spawnSync ?? defaultSpawnSync;
  let releaseLock;
  let sources;

  try {
    assertNode24(dependencies.nodeVersion ?? process.versions.node);
    assertIndependentStateDir(codexHome, stateDir);
    if (runtime.execute) {
      releaseLock = acquireLock(stateDir, lockPath);
      if (releaseLock === null) {
        emit(logger, "blocked", { mode, reason: "concurrent_run" });
        return { exitCode: 0, outcome: "blocked" };
      }
    }

    const backoff = readBackoff(backoffPath);
    const backoffActive = backoff.nextAttemptAtMs > nowMs;
    if (runtime.execute && backoffActive) {
      emit(logger, "blocked", {
        mode,
        reason: "backoff_active",
        retryAfterMs: backoff.nextAttemptAtMs - nowMs,
      });
      return { exitCode: 0, outcome: "blocked" };
    }

    sources = openSources(codexHome);
    const scan = await scanSources(sources, codexHome, nowMs, runtime.silentMs);
    const selected = scan.candidates[0];
    if (selected === undefined) {
      emit(logger, "scan_complete", scanLogFields(mode, scan, runtime.silentMinutes, undefined, "none"));
      return { exitCode: 0, outcome: "no_candidate" };
    }

    if (!runtime.execute) {
      let action = "would_resume";
      if (existsSync(lockPath)) {
        action = "blocked_by_concurrent_run";
      } else if (backoffActive) {
        action = "blocked_by_backoff";
      }
      emit(logger, "scan_complete", scanLogFields(mode, scan, runtime.silentMinutes, selected, action));
      return { exitCode: 0, outcome: action };
    }

    if (!revalidateCandidate(selected, sources)) {
      emit(logger, "blocked", {
        mode,
        reason: "candidate_changed",
        selected: threadReference(selected.threadId),
      });
      return { exitCode: 0, outcome: "blocked" };
    }

    closeSources(sources);
    sources = undefined;
    emit(logger, "resume_started", {
      mode,
      selected: threadReference(selected.threadId),
    });
    let result;
    try {
      result = spawnSync(
        "codex",
        ["exec", "resume", selected.threadId, CONTINUE_PROMPT],
        {
          shell: false,
          stdio: "ignore",
        },
      );
    } catch {
      result = { error: new Error(), status: null };
    }
    if (result.status === 0 && result.error === undefined) {
      try {
        rmSync(backoffPath, { force: true });
      } catch {
        throw new WatchdogError("backoff_clear_failed");
      }
      emit(logger, "resume_succeeded", {
        mode,
        selected: threadReference(selected.threadId),
      });
      return { exitCode: 0, outcome: "resumed" };
    }

    const advancedBackoff = nextBackoff(backoff, nowMs);
    writeBackoff(stateDir, backoffPath, advancedBackoff);
    emit(logger, "resume_failed", {
      failures: advancedBackoff.failures,
      mode,
      reason: result.error === undefined ? "nonzero_exit" : "spawn_error",
      retryAfterMs: advancedBackoff.nextAttemptAtMs - nowMs,
      selected: threadReference(selected.threadId),
      status: Number.isInteger(result.status) ? result.status : null,
    });
    return { exitCode: 1, outcome: "resume_failed" };
  } catch (error) {
    emit(logger, "blocked", { mode, reason: reasonFor(error) });
    return { exitCode: 2, outcome: "blocked" };
  } finally {
    if (sources !== undefined) {
      closeSources(sources);
    }
    if (releaseLock !== undefined) {
      try {
        releaseLock();
      } catch (error) {
        emit(logger, "blocked", { mode, reason: reasonFor(error) });
      }
    }
  }
}

export function parseArguments(args) {
  let execute = false;
  let executeSeen = false;
  let silentMinutes = DEFAULT_SILENT_MINUTES;
  let silenceSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--execute") {
      if (executeSeen) {
        throw new WatchdogError("invalid_arguments");
      }
      executeSeen = true;
      execute = true;
      continue;
    }
    if (argument === "--silent-minutes") {
      const value = args[index + 1];
      if (silenceSeen || typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
        throw new WatchdogError("invalid_arguments");
      }
      silentMinutes = Number(value);
      if (!isPositiveSafeInteger(silentMinutes)) {
        throw new WatchdogError("invalid_arguments");
      }
      silenceSeen = true;
      index += 1;
      continue;
    }
    throw new WatchdogError("invalid_arguments");
  }

  return { execute, silentMinutes };
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    emit(defaultLogger, "blocked", { mode: "unknown", reason: reasonFor(error) });
    process.exitCode = 2;
    return;
  }
  const result = await runWatchdog(options);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
