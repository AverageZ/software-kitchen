import assert from "node:assert/strict";
import { test } from "node:test";

import { bumpLevel, countUpdates, parseBump } from "./bump.ts";

test("parses single-package Dependabot titles, with or without a commit prefix and directory", () => {
  assert.deepEqual(parseBump("Bump @vitejs/plugin-react-swc from 4.3.0 to 4.3.1", ""), {
    package: "@vitejs/plugin-react-swc",
    from: "4.3.0",
    to: "4.3.1",
    directory: null,
    level: "patch",
  });
  assert.deepEqual(parseBump("chore(deps): bump vite from 7.1.0 to 7.2.0 in /web", ""), {
    package: "vite",
    from: "7.1.0",
    to: "7.2.0",
    directory: "/web",
    level: "minor",
  });
});

test("group updates and other titles are not single-package bumps", () => {
  assert.equal(
    parseBump("Bump the npm_and_yarn group across 1 directory with 3 updates", ""),
    null,
  );
  assert.equal(parseBump("Fix the build", ""), null);
});

// Table rows copied from real Renovate PRs: renovatebot/renovate#47190 and #47264, gitlab-org/gitlab-ui!5173.
const EXECA_ROW =
  "| [execa](https://redirect.github.com/sindresorhus/execa) | [`10.1.0` → `10.1.1`](https://renovatebot.com/diffs/npm/execa/10.1.0/10.1.1) | ![age](https://developer.mend.io/api/mc/badges/age/npm/execa/10.1.1?slim=true) |";

const NODE_ROW =
  "| [node](https://redirect.github.com/containerbase/node-prebuild) | patch | `24.22.0` → `24.22.1` |";

const DOMPURIFY_ROW =
  "| [dompurify](https://github.com/cure53/DOMPurify) | devDependencies | patch | [`3.2.5` -> `3.2.6`](https://renovatebot.com/diffs/npm/dompurify/3.2.5/3.2.6) |";

function renovateBody(...rows: string[]): string {
  return [
    "This PR contains the following updates:",
    "",
    "| Package | Change |",
    "|---|---|",
    ...rows,
  ].join("\n");
}

test("parses Renovate PRs, taking the old version from the body's update table", () => {
  const cases: Array<[string, string, string, string, string]> = [
    [
      "build(deps): update dependency execa to v10.1.1 (main)",
      EXECA_ROW,
      "execa",
      "10.1.0",
      "10.1.1",
    ],
    [
      "build(deps): update dependency node to v24.22.1 (main)",
      NODE_ROW,
      "node",
      "24.22.0",
      "24.22.1",
    ],
    [
      "chore(deps): update dependency dompurify to v3.2.6",
      DOMPURIFY_ROW,
      "dompurify",
      "3.2.5",
      "3.2.6",
    ],
  ];

  for (const [title, row, name, from, to] of cases) {
    assert.deepEqual(
      parseBump(title, renovateBody(row)),
      { package: name, from, to, directory: null, level: "patch" },
      title,
    );
  }
});

test("a Renovate major names only the major in the title; the body gives the full version", () => {
  const row =
    "| [vite](https://vite.dev) | [`7.1.2` → `8.0.0`](https://renovatebot.com/diffs/npm/vite/7.1.2/8.0.0) |";

  assert.equal(
    parseBump("Update dependency vite to v8 [SECURITY]", renovateBody(row))?.level,
    "major",
  );
  assert.equal(parseBump("Update dependency vite to v8", renovateBody(row))?.to, "8.0.0");
});

test("Renovate range bumps compare the versions inside the ranges", () => {
  const row =
    "| [zod](https://zod.dev) | [`^4.5.0` → `^4.6.7`](https://renovatebot.com/diffs/npm/zod/4.5.0/4.6.7) |";

  assert.deepEqual(parseBump("Update dependency zod to v4.6.7", renovateBody(row)), {
    package: "zod",
    from: "4.5.0",
    to: "4.6.7",
    directory: null,
    level: "minor",
  });
});

test("Renovate PRs whose body doesn't back up the title are not bumps", () => {
  const title = "chore(deps): update dependency execa to v10.1.1";

  assert.equal(parseBump(title, renovateBody(EXECA_ROW, DOMPURIFY_ROW)), null, "two updates");
  assert.equal(parseBump(title, renovateBody(DOMPURIFY_ROW)), null, "another package");
  assert.equal(parseBump(title, "Updated execa."), null, "no table");
  assert.equal(
    parseBump("Update dependency execa to v1", renovateBody(EXECA_ROW)),
    null,
    "v1 is not v10",
  );
  assert.equal(
    parseBump("Update all non-major dependencies", renovateBody(EXECA_ROW)),
    null,
    "group",
  );
});

test("version levels follow caret semantics, so 0.x minors count as major", () => {
  const cases: Array<[string, string, string]> = [
    ["1.2.3", "1.2.4", "patch"],
    ["1.2.3", "1.3.0", "minor"],
    ["1.2.3", "2.0.0", "major"],
    ["v1.2.3", "v1.2.4", "patch"],
    ["0.3.1", "0.3.2", "minor"],
    ["0.3.1", "0.4.0", "major"],
    ["0.0.3", "0.0.4", "major"],
    ["1.0.0-beta.1", "1.0.0", "prerelease"],
    ["2.0.0", "1.9.0", "unknown"],
    ["1.2.3", "1.2.3", "unknown"],
    ["abc1234", "def5678", "unknown"],
  ];

  for (const [from, to, level] of cases)
    assert.equal(bumpLevel(from, to), level, `${from} → ${to}`);
});

test("update counts: Renovate table rows, 1 for a Dependabot bump, N for a Dependabot group", () => {
  const cases: Array<[string, string, number]> = [
    ["chore(deps): update dependency execa to v10.1.1", renovateBody(EXECA_ROW), 1],
    ["Update all non-major dependencies", renovateBody(EXECA_ROW, DOMPURIFY_ROW, NODE_ROW), 3],
    ["Bump vite from 7.1.0 to 7.1.2 in /web", "", 1],
    ["Bump the npm_and_yarn group across 1 directory with 3 updates", "", 3],
    ["chore(deps): bump the dev group in /web with 1 update", "", 1],
    ["Fix the build", "Nothing to see.", 0],
  ];

  for (const [title, body, count] of cases) assert.equal(countUpdates(title, body), count, title);
});
