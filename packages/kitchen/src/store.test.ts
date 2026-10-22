import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { KitchenStore } from "./store.ts";

test("github.com Inputs stored before other hosts existed still deduplicate", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitchen-store-"));
  const path = join(dir, "kitchen.db");

  try {
    new KitchenStore(path).close();

    const db = new DatabaseSync(path);

    db.exec(`INSERT INTO inputs (source, kind, raw, key, received_at)
      VALUES ('cli', 'github-pr', 'https://github.com/octo/app/pull/1', 'github-pr:octo/app#1', '2026-01-01')`);
    db.exec(`INSERT INTO work_items (input_id, recipe, repo, scope, status, created_at, updated_at)
      VALUES (1, 'dependabot-bump', 'octo/app', 'octo/app#1', 'done', '2026-01-01', '2026-01-01')`);
    db.close();

    const store = new KitchenStore(path);

    try {
      const again = store.addInput({
        source: "cli",
        kind: "pull-request",
        raw: "https://github.com/octo/app/pull/1/files",
        key: "pull-request:github.com/octo/app#1",
      });

      assert.equal(again.created, false);
      assert.equal(again.input.id, 1);
      assert.equal(store.getWorkItem(1)?.scope, "github.com/octo/app#1");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
