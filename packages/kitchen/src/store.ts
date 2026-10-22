import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";

import {
  assessmentInputSchema,
  safetyAssessmentSchema,
  type AssessmentInput,
  type SafetyAssessment,
} from "./safety/assessment.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inputs (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  raw         TEXT NOT NULL,
  key         TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_items (
  id          INTEGER PRIMARY KEY,
  input_id    INTEGER NOT NULL REFERENCES inputs(id),
  recipe      TEXT NOT NULL,
  repo        TEXT NOT NULL,
  scope       TEXT NOT NULL,
  risk        TEXT,
  status      TEXT NOT NULL,
  run_id      TEXT,
  wake_at     TEXT,
  wake_action TEXT,
  reason      TEXT,
  next_action TEXT,
  result_url  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (input_id, recipe)
);
CREATE TABLE IF NOT EXISTS decisions (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,
  input_id      INTEGER NOT NULL REFERENCES inputs(id),
  run_id        TEXT,
  model         TEXT NOT NULL,
  subject       TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  confidence    REAL NOT NULL,
  answers       TEXT NOT NULL,
  owner_verdict TEXT,
  owner_note    TEXT,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assessments (
  id               INTEGER PRIMARY KEY,
  work_item_id     INTEGER REFERENCES work_items(id),
  run_id           TEXT,
  source           TEXT NOT NULL,
  repo             TEXT NOT NULL,
  scope            TEXT NOT NULL,
  head_sha         TEXT NOT NULL,
  decision         TEXT NOT NULL,
  grade            TEXT,
  score            INTEGER,
  policy_version   TEXT NOT NULL,
  input            TEXT NOT NULL,
  assessment       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  execution_status TEXT,
  execution_detail TEXT,
  executed_at      TEXT
);
CREATE INDEX IF NOT EXISTS assessments_scope ON assessments (scope, id);
`;

// Inputs stored before the kitchen knew other hosts were github.com PRs keyed `github-pr:owner/repo#n`.
const MIGRATE_GITHUB_ONLY = `
BEGIN;
UPDATE work_items SET repo = 'github.com/' || repo, scope = 'github.com/' || scope
  WHERE input_id IN (SELECT id FROM inputs WHERE kind = 'github-pr');
UPDATE inputs SET kind = 'pull-request', key = 'pull-request:github.com/' || substr(key, length('github-pr:') + 1)
  WHERE kind = 'github-pr';
COMMIT;
`;

// WorkItems stored before reruns existed had only CI waits, which resume the suspended run.
const MIGRATE_WAKE_ACTION = `
BEGIN;
ALTER TABLE work_items ADD COLUMN wake_action TEXT;
UPDATE work_items SET wake_action = 'resume' WHERE status = 'waiting';
COMMIT;
`;

const inputSchema = z.object({
  id: z.number(),
  source: z.string(),
  kind: z.literal("pull-request"),
  raw: z.string(),
  key: z.string(),
  receivedAt: z.string(),
});

export type Input = z.infer<typeof inputSchema>;

export const workItemStatusSchema = z.enum(["ready", "running", "waiting", "done", "parked"]);

export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;

const workItemSchema = z.object({
  id: z.number(),
  inputId: z.number(),
  recipe: z.string(),
  repo: z.string(),
  scope: z.string(),
  risk: z.string().nullable(),
  status: workItemStatusSchema,
  runId: z.string().nullable(),
  wakeAt: z.string().nullable(),
  /** What a due tick does: `resume` the suspended run (CI wait) or start a fresh `rerun` (deferred). */
  wakeAction: z.enum(["resume", "rerun"]).nullable(),
  reason: z.string().nullable(),
  nextAction: z.string().nullable(),
  resultUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WorkItem = z.infer<typeof workItemSchema>;

const decisionSchema = z.object({
  id: z.number(),
  /** `bump-rating` rows predate the safety assessment; they stay readable but are no longer written. */
  kind: z.enum(["triage", "bump-rating", "release-notes"]),
  inputId: z.number(),
  runId: z.string().nullable(),
  model: z.string(),
  subject: z.string(),
  verdict: z.string(),
  confidence: z.number(),
  answers: z.string(),
  ownerVerdict: z.string().nullable(),
  ownerNote: z.string().nullable(),
  createdAt: z.string(),
});

export type Decision = z.infer<typeof decisionSchema>;

export const executionStatusSchema = z.enum(["merged", "refused", "failed"]);

export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

const assessmentRowSchema = z.object({
  id: z.number(),
  workItemId: z.number().nullable(),
  runId: z.string().nullable(),
  source: z.enum(["run", "eval"]),
  repo: z.string(),
  scope: z.string(),
  input: z.string(),
  assessment: z.string(),
  createdAt: z.string(),
  executionStatus: executionStatusSchema.nullable(),
  executionDetail: z.string().nullable(),
  executedAt: z.string().nullable(),
});

/** An assessment as recorded, with the exact input that reproduces it. */
export interface StoredAssessment {
  id: number;
  workItemId: number | null;
  runId: string | null;
  /** `run`: a recipe run. `eval`: a historical replay, never acted on. */
  source: "run" | "eval";
  repo: string;
  scope: string;
  input: AssessmentInput;
  assessment: SafetyAssessment;
  createdAt: string;
  execution: { status: ExecutionStatus; detail: string; at: string } | null;
}

export interface NewAssessment {
  workItemId: number | null;
  runId: string | null;
  source: StoredAssessment["source"];
  repo: string;
  scope: string;
  input: AssessmentInput;
  assessment: SafetyAssessment;
}

export interface AddedInput {
  input: Input;
  /** False when an Input with the same key was already stored. */
  created: boolean;
}

export interface AddedWorkItem {
  workItem: WorkItem;
  /** False when the Input already had a WorkItem for this recipe. */
  created: boolean;
}

const INPUT_COLUMNS = "id, source, kind, raw, key, received_at AS receivedAt";

const WORK_ITEM_COLUMNS = `id, input_id AS inputId, recipe, repo, scope, risk, status, run_id AS runId,
  wake_at AS wakeAt, wake_action AS wakeAction, reason, next_action AS nextAction, result_url AS resultUrl,
  created_at AS createdAt, updated_at AS updatedAt`;

const DECISION_COLUMNS = `id, kind, input_id AS inputId, run_id AS runId, model, subject, verdict, confidence,
  answers, owner_verdict AS ownerVerdict, owner_note AS ownerNote, created_at AS createdAt`;

const ASSESSMENT_COLUMNS = `id, work_item_id AS workItemId, run_id AS runId, source, repo, scope, input,
  assessment, created_at AS createdAt, execution_status AS executionStatus,
  execution_detail AS executionDetail, executed_at AS executedAt`;

export interface NewInput {
  source: string;
  kind: Input["kind"];
  raw: string;
  key: string;
}

export interface NewWorkItem {
  inputId: number;
  recipe: string;
  repo: string;
  scope: string;
  risk: string | null;
}

export interface NewDecision {
  kind: Decision["kind"];
  inputId: number;
  runId: string | null;
  model: string;
  subject: string;
  verdict: string;
  confidence: number;
  answers: string;
}

/** Inputs, WorkItems, recorded model decisions, and safety assessments. Mastra stores the runs themselves. */
export class KitchenStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.#db.exec(SCHEMA);
    this.#db.exec(MIGRATE_GITHUB_ONLY);

    const columns = this.#db.prepare("PRAGMA table_info(work_items)").all();

    if (!columns.some((column) => column["name"] === "wake_action")) {
      this.#db.exec(MIGRATE_WAKE_ACTION);
    }
  }

  close(): void {
    this.#db.close();
  }

  /** Stores an Input unless one with the same key exists. Returns the stored Input either way. */
  addInput(input: NewInput): AddedInput {
    const result = this.#db
      .prepare(
        "INSERT INTO inputs (source, kind, raw, key, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING",
      )
      .run(input.source, input.kind, input.raw, input.key, new Date().toISOString());

    const stored = inputSchema.parse(
      this.#db.prepare(`SELECT ${INPUT_COLUMNS} FROM inputs WHERE key = ?`).get(input.key),
    );

    return { input: stored, created: result.changes === 1 };
  }

  getInput(id: number): Input | null {
    const row = this.#db.prepare(`SELECT ${INPUT_COLUMNS} FROM inputs WHERE id = ?`).get(id);

    return row === undefined ? null : inputSchema.parse(row);
  }

  listInputs(): Input[] {
    return this.#db
      .prepare(`SELECT ${INPUT_COLUMNS} FROM inputs ORDER BY id`)
      .all()
      .map((row) => inputSchema.parse(row));
  }

  /** Creates a WorkItem in `ready`, or returns the existing one for the same Input and recipe. */
  addWorkItem(item: NewWorkItem): AddedWorkItem {
    const now = new Date().toISOString();

    const result = this.#db
      .prepare(
        `INSERT INTO work_items (input_id, recipe, repo, scope, risk, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ready', ?, ?) ON CONFLICT (input_id, recipe) DO NOTHING`,
      )
      .run(item.inputId, item.recipe, item.repo, item.scope, item.risk, now, now);

    const stored = workItemSchema.parse(
      this.#db
        .prepare(`SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE input_id = ? AND recipe = ?`)
        .get(item.inputId, item.recipe),
    );

    return { workItem: stored, created: result.changes === 1 };
  }

  getWorkItem(id: number): WorkItem | null {
    const row = this.#db
      .prepare(`SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE id = ?`)
      .get(id);

    return row === undefined ? null : workItemSchema.parse(row);
  }

  listWorkItems(): WorkItem[] {
    return this.#db
      .prepare(`SELECT ${WORK_ITEM_COLUMNS} FROM work_items ORDER BY id`)
      .all()
      .map((row) => workItemSchema.parse(row));
  }

  /** Waiting WorkItems whose wake time has passed. */
  listDue(now: Date): WorkItem[] {
    return this.#db
      .prepare(
        `SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE status = 'waiting' AND wake_at <= ? ORDER BY wake_at`,
      )
      .all(now.toISOString())
      .map((row) => workItemSchema.parse(row));
  }

  markRunning(id: number, runId: string): void {
    this.#db
      .prepare(
        "UPDATE work_items SET status = 'running', run_id = ?, wake_at = NULL, wake_action = NULL, reason = NULL, next_action = NULL, updated_at = ? WHERE id = ?",
      )
      .run(runId, new Date().toISOString(), id);
  }

  markWaiting(id: number, wakeAt: string, wakeAction: "resume" | "rerun", reason: string): void {
    this.#db
      .prepare(
        "UPDATE work_items SET status = 'waiting', wake_at = ?, wake_action = ?, reason = ?, next_action = NULL, updated_at = ? WHERE id = ?",
      )
      .run(wakeAt, wakeAction, reason, new Date().toISOString(), id);
  }

  markDone(id: number, resultUrl: string | null): void {
    this.#db
      .prepare(
        "UPDATE work_items SET status = 'done', wake_at = NULL, wake_action = NULL, reason = NULL, next_action = NULL, result_url = ?, updated_at = ? WHERE id = ?",
      )
      .run(resultUrl, new Date().toISOString(), id);
  }

  markParked(id: number, reason: string, nextAction: string, resultUrl: string | null): void {
    this.#db
      .prepare(
        `UPDATE work_items SET status = 'parked', wake_at = NULL, wake_action = NULL, reason = ?, next_action = ?,
         result_url = COALESCE(?, result_url), updated_at = ? WHERE id = ?`,
      )
      .run(reason, nextAction, resultUrl, new Date().toISOString(), id);
  }

  addDecision(decision: NewDecision): Decision {
    const result = this.#db
      .prepare(
        `INSERT INTO decisions (kind, input_id, run_id, model, subject, verdict, confidence, answers, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.kind,
        decision.inputId,
        decision.runId,
        decision.model,
        decision.subject,
        decision.verdict,
        decision.confidence,
        decision.answers,
        new Date().toISOString(),
      );

    return decisionSchema.parse(
      this.#db
        .prepare(`SELECT ${DECISION_COLUMNS} FROM decisions WHERE id = ?`)
        .get(result.lastInsertRowid),
    );
  }

  listDecisions(): Decision[] {
    return this.#db
      .prepare(`SELECT ${DECISION_COLUMNS} FROM decisions ORDER BY id`)
      .all()
      .map((row) => decisionSchema.parse(row));
  }

  getDecision(id: number): Decision | null {
    const row = this.#db.prepare(`SELECT ${DECISION_COLUMNS} FROM decisions WHERE id = ?`).get(id);

    return row === undefined ? null : decisionSchema.parse(row);
  }

  /** Records the owner's own call next to the model's. Returns false if the decision doesn't exist. */
  reviewDecision(id: number, ownerVerdict: string, ownerNote: string | null): boolean {
    const result = this.#db
      .prepare("UPDATE decisions SET owner_verdict = ?, owner_note = ? WHERE id = ?")
      .run(ownerVerdict, ownerNote, id);

    return result.changes === 1;
  }

  addAssessment(record: NewAssessment): StoredAssessment {
    const { assessment } = record;

    const result = this.#db
      .prepare(
        `INSERT INTO assessments (work_item_id, run_id, source, repo, scope, head_sha, decision, grade, score,
           policy_version, input, assessment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.workItemId,
        record.runId,
        record.source,
        record.repo,
        record.scope,
        assessment.headSha,
        assessment.decision,
        assessment.grade,
        assessment.score,
        assessment.policyVersion,
        JSON.stringify(record.input),
        JSON.stringify(assessment),
        new Date().toISOString(),
      );

    const stored = this.getAssessment(Number(result.lastInsertRowid));

    if (stored === null) throw new Error("assessment vanished after insert");

    return stored;
  }

  getAssessment(id: number): StoredAssessment | null {
    const row = this.#db
      .prepare(`SELECT ${ASSESSMENT_COLUMNS} FROM assessments WHERE id = ?`)
      .get(id);

    return row === undefined ? null : toStoredAssessment(row);
  }

  /** Assessments newest first; `source` narrows to runs or historical replays. */
  listAssessments(source: StoredAssessment["source"], limit: number): StoredAssessment[] {
    return this.#db
      .prepare(
        `SELECT ${ASSESSMENT_COLUMNS} FROM assessments WHERE source = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(source, limit)
      .map(toStoredAssessment);
  }

  /**
   * Run assessments that decided AUTO_MERGE and haven't been acted on, each the latest for its PR:
   * a newer assessment of the same PR supersedes an older one whatever it decided.
   */
  listMergeCandidates(): StoredAssessment[] {
    return this.#db
      .prepare(
        `SELECT ${ASSESSMENT_COLUMNS} FROM assessments a
         WHERE source = 'run' AND decision = 'AUTO_MERGE' AND execution_status IS NULL
           AND id = (SELECT MAX(id) FROM assessments b WHERE b.scope = a.scope AND b.source = 'run')
         ORDER BY id`,
      )
      .all()
      .map(toStoredAssessment);
  }

  /** Decisions of a WorkItem's latest assessments, newest first. */
  recentDecisions(workItemId: number, limit: number): string[] {
    return this.#db
      .prepare("SELECT decision FROM assessments WHERE work_item_id = ? ORDER BY id DESC LIMIT ?")
      .all(workItemId, limit)
      .map((row) => decisionRowSchema.parse(row).decision);
  }

  recordExecution(id: number, status: ExecutionStatus, detail: string): void {
    this.#db
      .prepare(
        "UPDATE assessments SET execution_status = ?, execution_detail = ?, executed_at = ? WHERE id = ?",
      )
      .run(status, detail, new Date().toISOString(), id);
  }
}

const decisionRowSchema = z.object({ decision: z.string() });

function toStoredAssessment(row: Record<string, SQLOutputValue>): StoredAssessment {
  const parsed = assessmentRowSchema.parse(row);

  return {
    id: parsed.id,
    workItemId: parsed.workItemId,
    runId: parsed.runId,
    source: parsed.source,
    repo: parsed.repo,
    scope: parsed.scope,
    input: assessmentInputSchema.parse(JSON.parse(parsed.input)),
    assessment: safetyAssessmentSchema.parse(JSON.parse(parsed.assessment)),
    createdAt: parsed.createdAt,
    execution:
      parsed.executionStatus === null
        ? null
        : {
            status: parsed.executionStatus,
            detail: parsed.executionDetail ?? "",
            at: parsed.executedAt ?? "",
          },
  };
}
