import assert from "node:assert/strict";
import { test } from "node:test";

import { bumpLevel, parseBumpTitle } from "./bump.ts";

test("parses single-package Dependabot titles, with or without a commit prefix and directory", () => {
  assert.deepEqual(parseBumpTitle("Bump @vitejs/plugin-react-swc from 4.3.0 to 4.3.1"), {
    package: "@vitejs/plugin-react-swc",
    from: "4.3.0",
    to: "4.3.1",
    directory: null,
    level: "patch",
  });
  assert.deepEqual(parseBumpTitle("chore(deps): bump vite from 7.1.0 to 7.2.0 in /web"), {
    package: "vite",
    from: "7.1.0",
    to: "7.2.0",
    directory: "/web",
    level: "minor",
  });
});

test("group updates and other titles are not single-package bumps", () => {
  assert.equal(
    parseBumpTitle("Bump the npm_and_yarn group across 1 directory with 3 updates"),
    null,
  );
  assert.equal(parseBumpTitle("Fix the build"), null);
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
