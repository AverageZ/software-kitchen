import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig, policyFor } from "./config.ts";
import { DEFAULT_POLICY, policyVersion, resolvePolicy } from "./safety/policy.ts";

function withConfig(json: string, check: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "kitchen-config-"));
  const path = join(dir, "config.json");

  try {
    writeFileSync(path, json);
    check(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const APP = { "github.com": { appId: 1, privateKeyPath: "/keys/merge.pem" } };

test("a repo override applies to that repo only, on top of the default override", () => {
  const json = JSON.stringify({
    safety: {
      default: { safety: { minimumReleaseAgeHours: 96 } },
      repos: {
        "github.com/octo/app": {
          mode: "autonomous",
          automation: { merge: true },
          eligibility: { bots: ["renovate[bot]", "dependabot[bot]"] },
        },
      },
    },
  });

  withConfig(json, (path) => {
    const config = loadConfig(path);
    const app = policyFor(config, { forge: "github", host: "github.com", project: "octo/app" });
    const other = policyFor(config, { forge: "github", host: "github.com", project: "octo/web" });

    assert.equal(app.mode, "autonomous");
    assert.equal(app.automation.merge, true);
    assert.equal(app.automation.approve, false, "untouched siblings keep the default");
    assert.deepEqual(app.eligibility.bots, ["renovate[bot]", "dependabot[bot]"], "arrays replace");
    assert.equal(app.safety.minimumReleaseAgeHours, 96);
    assert.equal(other.mode, "observe");
    assert.equal(other.safety.minimumReleaseAgeHours, 96);
  });
});

test("a misspelled policy field fails at load, naming the field", () => {
  const json = JSON.stringify({
    safety: { repos: { "github.com/octo/app": { grading: { autonomousMergeMinimumScor: 90 } } } },
  });

  withConfig(json, (path) => assert.throws(() => loadConfig(path), /autonomousMergeMinimumScor/));
});

test("merge credentials on the host forbid running PR code under any policy", () => {
  withConfig(JSON.stringify({ githubApps: APP }), (path) =>
    assert.throws(() => loadConfig(path), /must not run here.*safety\.default/),
  );

  const repoTurnsTestsOn = JSON.stringify({
    githubApps: APP,
    safety: {
      default: { verification: { localTests: false } },
      repos: { "github.com/octo/app": { verification: { localTests: true } } },
    },
  });

  withConfig(repoTurnsTestsOn, (path) =>
    assert.throws(() => loadConfig(path), /safety\.repos\["github\.com\/octo\/app"\]/),
  );

  const testsOff = JSON.stringify({
    githubApps: APP,
    safety: { default: { verification: { localTests: false } } },
  });

  withConfig(testsOff, (path) =>
    assert.equal(loadConfig(path).githubApps.get("github.com")?.appId, "1"),
  );
});

test("the policy version changes with any resolved value, not only the declared rubric version", () => {
  const base = resolvePolicy([]);
  const stricter = resolvePolicy([{ grading: { deductions: { "impact.build-critical": 15 } } }]);

  assert.equal(policyVersion(base), policyVersion(resolvePolicy([])));
  assert.notEqual(policyVersion(base), policyVersion(stricter));
  assert.ok(policyVersion(base).startsWith(`${DEFAULT_POLICY.grading.rubricVersion}+`));
});
