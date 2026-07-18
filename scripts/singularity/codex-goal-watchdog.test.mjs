import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  CONTINUE_PROMPT,
  parseArguments,
  runWatchdog,
} from "./codex-goal-watchdog.mjs";

const NOW_MS = 2_000_000_000_000;
const THREAD_ID = "019f7012-bd90-75c0-9f42-5a7a0cfe8b34";
const TURN_ID = "019f7012-bd90-75c0-9f42-5a7a0cfe8b35";
const CALL_ID = "call_abcdefghijklmnopqrstuvwx";
const temporaryRoots = new Set();

afterEach(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  temporaryRoots.clear();
});

function event(type, payload) {
  return {
    payload: { type, ...payload },
    timestamp: "2033-05-18T03:33:20.000Z",
    type: type === "function_call"
      || type === "function_call_output"
      || type === "custom_tool_call"
      || type === "custom_tool_call_output"
      || type === "tool_search_call"
      || type === "tool_search_output"
      || type === "web_search_call"
      ? "response_item"
      : "event_msg",
  };
}

function abortedRollout() {
  return [
    event("task_started", { turn_id: TURN_ID }),
    event("turn_aborted", { reason: "interrupted", turn_id: TURN_ID }),
  ];
}

function createGoalDatabase(path, status, updatedAtMs, driftSchema) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY NOT NULL,
      goal_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'active',
        'paused',
        'blocked',
        'usage_limited',
        'budget_limited',
        'complete'
      )),
      token_budget INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  if (driftSchema === "goals") {
    database.exec("ALTER TABLE thread_goals ADD COLUMN unexpected TEXT");
  }
  database.prepare(`
    INSERT INTO thread_goals (
      thread_id,
      goal_id,
      objective,
      status,
      created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    THREAD_ID,
    "goal-secret-id",
    "confidential objective that must never reach logs",
    status,
    updatedAtMs - 1_000,
    updatedAtMs,
  );
  database.close();
}

function createStateDatabase(path, rolloutPath, archived, updatedAtMs, driftSchema) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      agent_nickname TEXT,
      agent_role TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled',
      model TEXT,
      reasoning_effort TEXT,
      agent_path TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      thread_source TEXT,
      preview TEXT NOT NULL DEFAULT '',
      recency_at INTEGER NOT NULL DEFAULT 0,
      recency_at_ms INTEGER NOT NULL DEFAULT 0,
      history_mode TEXT NOT NULL DEFAULT 'legacy'
    )
  `);
  if (driftSchema === "threads") {
    database.exec("ALTER TABLE threads ADD COLUMN unexpected TEXT");
  }
  database.prepare(`
    INSERT INTO threads (
      id,
      rollout_path,
      created_at,
      updated_at,
      source,
      model_provider,
      cwd,
      title,
      sandbox_policy,
      approval_mode,
      archived,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    THREAD_ID,
    rolloutPath,
    Math.trunc((updatedAtMs - 1_000) / 1_000),
    Math.trunc(updatedAtMs / 1_000),
    "vscode",
    "test-provider",
    "/confidential/workspace",
    "confidential thread title",
    "workspace-write",
    "on-request",
    archived,
    updatedAtMs,
  );
  database.close();
}

function createFixture({
  archived = 0,
  driftSchema,
  events = abortedRollout(),
  goalAgeMs = 3_600_000,
  rolloutAgeMs = 3_600_000,
  status = "active",
  threadAgeMs = 3_600_000,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "singularity-codex-watchdog-"));
  temporaryRoots.add(root);
  const codexHome = join(root, "codex");
  const sessions = join(codexHome, "sessions", "2033", "05", "18");
  const stateDir = join(root, "watchdog-state");
  const rolloutPath = join(sessions, `rollout-${THREAD_ID}.jsonl`);
  mkdirSync(sessions, { recursive: true });
  writeFileSync(rolloutPath, `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  const rolloutTimeSeconds = (NOW_MS - rolloutAgeMs) / 1_000;
  utimesSync(rolloutPath, rolloutTimeSeconds, rolloutTimeSeconds);
  createGoalDatabase(
    join(codexHome, "goals_1.sqlite"),
    status,
    NOW_MS - goalAgeMs,
    driftSchema,
  );
  createStateDatabase(
    join(codexHome, "state_5.sqlite"),
    rolloutPath,
    archived,
    NOW_MS - threadAgeMs,
    driftSchema,
  );
  return {
    codexHome,
    goalsPath: join(codexHome, "goals_1.sqlite"),
    rolloutPath,
    stateDir,
    statePath: join(codexHome, "state_5.sqlite"),
  };
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function dependencies(fixture, logs, spawnSync, now = NOW_MS) {
  return {
    codexHome: fixture.codexHome,
    log: (record) => logs.push(record),
    now: () => now,
    spawnSync,
    stateDir: fixture.stateDir,
  };
}

test("argument parsing keeps dry-run as the default and rejects ambiguous input", () => {
  assert.deepEqual(parseArguments([]), { execute: false, silentMinutes: 15 });
  assert.deepEqual(
    parseArguments(["--silent-minutes", "30", "--execute"]),
    { execute: true, silentMinutes: 30 },
  );
  assert.throws(() => parseArguments(["--execute", "--execute"]), /invalid_arguments/);
  assert.throws(() => parseArguments(["--silent-minutes", "0"]), /invalid_arguments/);
  assert.throws(() => parseArguments(["--unknown"]), /invalid_arguments/);
});

test("a non-Node-24 runtime fails closed before reading Codex state", async () => {
  const logs = [];
  const result = await runWatchdog(
    { execute: false, silentMinutes: 15 },
    {
      codexHome: "/unreadable/codex-home",
      log: (record) => logs.push(record),
      nodeVersion: "22.21.1",
      stateDir: "/unreadable/watchdog-state",
    },
  );

  assert.deepEqual(result, { exitCode: 2, outcome: "blocked" });
  assert.equal(logs[0].reason, "node_version_unsupported");
});

test("dry-run reports an eligible goal without spawning or writing state", async () => {
  const fixture = createFixture();
  const logs = [];
  let spawnCount = 0;
  const before = {
    goals: digest(fixture.goalsPath),
    rollout: digest(fixture.rolloutPath),
    state: digest(fixture.statePath),
  };

  const result = await runWatchdog(
    { execute: false, silentMinutes: 15 },
    dependencies(fixture, logs, () => {
      spawnCount += 1;
      return { status: 0 };
    }),
  );

  assert.deepEqual(result, { exitCode: 0, outcome: "would_resume" });
  assert.equal(spawnCount, 0);
  assert.equal(existsSync(fixture.stateDir), false);
  assert.deepEqual(
    {
      goals: digest(fixture.goalsPath),
      rollout: digest(fixture.rolloutPath),
      state: digest(fixture.statePath),
    },
    before,
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, "would_resume");
});

test("execute resumes one eligible thread with a fixed non-shell argument array", async () => {
  const fixture = createFixture({
    events: [
      event("task_started", { turn_id: TURN_ID }),
      event("function_call", { call_id: CALL_ID, name: "exec" }),
      event("function_call_output", { call_id: CALL_ID, output: "completed" }),
      event("turn_aborted", { reason: "interrupted", turn_id: TURN_ID }),
    ],
  });
  const logs = [];
  const calls = [];
  const before = {
    goals: digest(fixture.goalsPath),
    rollout: digest(fixture.rolloutPath),
    state: digest(fixture.statePath),
  };

  const result = await runWatchdog(
    { execute: true, silentMinutes: 15 },
    dependencies(fixture, logs, (command, args, options) => {
      calls.push({ args, command, options });
      return { status: 0 };
    }),
  );

  assert.deepEqual(result, { exitCode: 0, outcome: "resumed" });
  assert.deepEqual(calls, [{
    args: ["exec", "resume", THREAD_ID, CONTINUE_PROMPT],
    command: "codex",
    options: { shell: false, stdio: "ignore" },
  }]);
  assert.equal(existsSync(join(fixture.stateDir, "run.lock")), false);
  assert.deepEqual(
    {
      goals: digest(fixture.goalsPath),
      rollout: digest(fixture.rolloutPath),
      state: digest(fixture.statePath),
    },
    before,
  );

  const serializedLogs = JSON.stringify(logs);
  for (const secret of [
    THREAD_ID,
    CONTINUE_PROMPT,
    fixture.rolloutPath,
    "/confidential/workspace",
    "confidential objective",
    "confidential thread title",
  ]) {
    assert.equal(serializedLogs.includes(secret), false);
  }
});

const rejectionScenarios = [
  {
    expectedReason: undefined,
    fixture: { status: "paused" },
    name: "a non-active goal",
  },
  {
    expectedReason: "thread_archived",
    fixture: { archived: 1 },
    name: "an archived thread",
  },
  {
    expectedReason: "not_silent",
    fixture: { goalAgeMs: 60_000, rolloutAgeMs: 60_000, threadAgeMs: 60_000 },
    name: "a recently active thread",
  },
  {
    expectedReason: "turn_complete",
    fixture: {
      events: [
        event("task_started", { turn_id: TURN_ID }),
        event("task_complete", { turn_id: TURN_ID }),
      ],
    },
    name: "a completed turn",
  },
  {
    expectedReason: "lifecycle_unrecognized",
    fixture: {
      events: [event("task_started", { turn_id: TURN_ID })],
    },
    name: "a silent turn without an authoritative terminal event",
  },
  {
    expectedReason: "tool_incomplete",
    fixture: {
      events: [
        event("task_started", { turn_id: TURN_ID }),
        event("function_call", { call_id: CALL_ID, name: "exec" }),
        event("turn_aborted", { reason: "interrupted", turn_id: TURN_ID }),
      ],
    },
    name: "an aborted turn with an unfinished tool call",
  },
  {
    expectedReason: "tool_schema_unknown",
    fixture: {
      events: [
        event("task_started", { turn_id: TURN_ID }),
        event("web_search_call", { call_id: CALL_ID }),
        event("turn_aborted", { reason: "interrupted", turn_id: TURN_ID }),
      ],
    },
    name: "an aborted turn with an unknown call lifecycle",
  },
];

for (const scenario of rejectionScenarios) {
  test(`execute rejects ${scenario.name}`, async () => {
    const fixture = createFixture(scenario.fixture);
    const logs = [];
    let spawnCount = 0;

    const result = await runWatchdog(
      { execute: true, silentMinutes: 15 },
      dependencies(fixture, logs, () => {
        spawnCount += 1;
        return { status: 0 };
      }),
    );

    assert.deepEqual(result, { exitCode: 0, outcome: "no_candidate" });
    assert.equal(spawnCount, 0);
    if (scenario.expectedReason !== undefined) {
      assert.equal(logs[0].rejected[scenario.expectedReason], 1);
    } else {
      assert.equal(logs[0].active, 0);
    }
  });
}

for (const driftSchema of ["goals", "threads"]) {
  test(`${driftSchema} schema drift fails closed before process execution`, async () => {
    const fixture = createFixture({ driftSchema });
    const logs = [];
    let spawnCount = 0;

    const result = await runWatchdog(
      { execute: true, silentMinutes: 15 },
      dependencies(fixture, logs, () => {
        spawnCount += 1;
        return { status: 0 };
      }),
    );

    assert.deepEqual(result, { exitCode: 2, outcome: "blocked" });
    assert.equal(spawnCount, 0);
    assert.equal(logs.some((record) => record.reason === "schema_mismatch"), true);
  });
}

test("an existing concurrency lock blocks execution without being removed", async () => {
  const fixture = createFixture();
  const logs = [];
  const lockPath = join(fixture.stateDir, "run.lock");
  mkdirSync(lockPath, { recursive: true });
  let spawnCount = 0;

  const result = await runWatchdog(
    { execute: true, silentMinutes: 15 },
    dependencies(fixture, logs, () => {
      spawnCount += 1;
      return { status: 0 };
    }),
  );

  assert.deepEqual(result, { exitCode: 0, outcome: "blocked" });
  assert.equal(spawnCount, 0);
  assert.equal(existsSync(lockPath), true);
  assert.equal(logs[0].reason, "concurrent_run");
});

test("an unknown backoff schema blocks execution without spawning", async () => {
  const fixture = createFixture();
  const logs = [];
  mkdirSync(fixture.stateDir, { recursive: true });
  writeFileSync(
    join(fixture.stateDir, "backoff.json"),
    JSON.stringify({ failures: 1, nextAttemptAtMs: NOW_MS + 60_000, unexpected: true, version: 1 }),
    "utf8",
  );
  let spawnCount = 0;

  const result = await runWatchdog(
    { execute: true, silentMinutes: 15 },
    dependencies(fixture, logs, () => {
      spawnCount += 1;
      return { status: 0 };
    }),
  );

  assert.deepEqual(result, { exitCode: 2, outcome: "blocked" });
  assert.equal(spawnCount, 0);
  assert.equal(logs.some((record) => record.reason === "backoff_invalid"), true);
});

test("failed resumes back off exponentially and success clears watchdog state", async () => {
  const fixture = createFixture();
  const logs = [];
  let spawnCount = 0;
  const spawnSync = () => {
    spawnCount += 1;
    return { status: spawnCount < 3 ? 75 : 0 };
  };

  const first = await runWatchdog(
    { execute: true, silentMinutes: 15 },
    dependencies(fixture, logs, spawnSync, NOW_MS),
  );
  assert.deepEqual(first, { exitCode: 1, outcome: "resume_failed" });
  assert.deepEqual(
    JSON.parse(readFileSync(join(fixture.stateDir, "backoff.json"), "utf8")),
    { failures: 1, nextAttemptAtMs: NOW_MS + 60_000, version: 1 },
  );

  const blocked = await runWatchdog(
    { execute: true, silentMinutes: 15 },
    dependencies(fixture, logs, spawnSync, NOW_MS + 30_000),
  );
  assert.deepEqual(blocked, { exitCode: 0, outcome: "blocked" });
  assert.equal(spawnCount, 1);

  const second = await runWatchdog(
    { execute: true, silentMinutes: 15 },
    dependencies(fixture, logs, spawnSync, NOW_MS + 60_000),
  );
  assert.deepEqual(second, { exitCode: 1, outcome: "resume_failed" });
  assert.deepEqual(
    JSON.parse(readFileSync(join(fixture.stateDir, "backoff.json"), "utf8")),
    { failures: 2, nextAttemptAtMs: NOW_MS + 180_000, version: 1 },
  );

  const succeeded = await runWatchdog(
    { execute: true, silentMinutes: 15 },
    dependencies(fixture, logs, spawnSync, NOW_MS + 180_000),
  );
  assert.deepEqual(succeeded, { exitCode: 0, outcome: "resumed" });
  assert.equal(spawnCount, 3);
  assert.equal(existsSync(join(fixture.stateDir, "backoff.json")), false);
});
