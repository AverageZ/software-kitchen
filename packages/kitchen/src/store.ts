import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

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
`;

const inputSchema = z.object({
  id: z.number(),
  source: z.string(),
  kind: z.literal("github-pr"),
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
  reason: z.string().nullable(),
  nextAction: z.string().nullable(),
  resultUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WorkItem = z.infer<typeof workItemSchema>;

const decisionSchema = z.object({
  id: z.number(),
  kind: z.enum(["triage", "bump-rating"]),
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
  wake_at AS wakeAt, reason, next_action AS nextAction, result_url AS resultUrl,
  created_at AS createdAt, updated_at AS updatedAt`;

const DECISION_COLUMNS = `id, kind, input_id AS inputId, run_id AS runId, model, subject, verdict, confidence,
  answers, owner_verdict AS ownerVerdict, owner_note AS ownerNote, created_at AS createdAt`;

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

/** Inputs, WorkItems, and recorded model decisions. Mastra stores the runs themselves. */
export class KitchenStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.#db.exec(SCHEMA);
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
        "UPDATE work_items SET status = 'running', run_id = ?, wake_at = NULL, reason = NULL, next_action = NULL, updated_at = ? WHERE id = ?",
      )
      .run(runId, new Date().toISOString(), id);
  }

  markWaiting(id: number, wakeAt: string, reason: string): void {
    this.#db
      .prepare(
        "UPDATE work_items SET status = 'waiting', wake_at = ?, reason = ?, next_action = NULL, updated_at = ? WHERE id = ?",
      )
      .run(wakeAt, reason, new Date().toISOString(), id);
  }

  markDone(id: number, resultUrl: string | null): void {
    this.#db
      .prepare(
        "UPDATE work_items SET status = 'done', wake_at = NULL, reason = NULL, next_action = NULL, result_url = ?, updated_at = ? WHERE id = ?",
      )
      .run(resultUrl, new Date().toISOString(), id);
  }

  markParked(id: number, reason: string, nextAction: string, resultUrl: string | null): void {
    this.#db
      .prepare(
        `UPDATE work_items SET status = 'parked', wake_at = NULL, reason = ?, next_action = ?,
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

  /** Records the owner's own call next to the model's. Returns false if the decision doesn't exist. */
  reviewDecision(id: number, ownerVerdict: string, ownerNote: string | null): boolean {
    const result = this.#db
      .prepare("UPDATE decisions SET owner_verdict = ?, owner_note = ? WHERE id = ?")
      .run(ownerVerdict, ownerNote, id);

    return result.changes === 1;
  }
}
