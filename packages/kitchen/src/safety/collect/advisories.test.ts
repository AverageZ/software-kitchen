import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectAdvisories,
  githubMalwareSource,
  npmAuditSource,
  type AdvisorySource,
} from "./advisories.ts";
import type { FetchFn } from "./registry.ts";

// Trimmed from a real bulk advisory response.
const BULK_REPORT = {
  vite: [
    {
      id: 1103629,
      url: "https://github.com/advisories/GHSA-g4jq-h2w9-997c",
      title: "Vite's `server.fs` settings were not applied to HTML files",
      severity: "low",
      vulnerable_versions: ">=7.1.0 <=7.1.10",
      cwe: ["CWE-23"],
    },
    {
      id: 1102938,
      url: "https://github.com/advisories/GHSA-93m4-6634-74q7",
      title: "vite allows server.fs.deny bypass via backslash on Windows",
      severity: "moderate",
      vulnerable_versions: ">=6.0.0 <6.4.1",
    },
  ],
  "event-stream": [
    {
      id: 737,
      url: "https://github.com/advisories/GHSA-mh6f-8j2x-4483",
      title: "Critical severity vulnerability that affects event-stream and flatmap-stream",
      overview: "The package contains malicious code that steals cryptocurrency wallets.",
      severity: "critical",
      vulnerable_versions: "=3.3.6",
    },
  ],
};

test("npm audit keeps advisories whose range covers the version, and spots malware", async () => {
  const bodies: string[] = [];

  const fetchFn: FetchFn = async (input, init) => {
    assert.equal(String(input), "https://registry.example/-/npm/v1/security/advisories/bulk");
    assert.equal(init?.method, "POST");
    bodies.push(String(init?.body));

    return Response.json(BULK_REPORT);
  };

  const advisories = await npmAuditSource("https://registry.example/", fetchFn).check([
    { name: "vite", version: "7.1.3" },
    { name: "event-stream", version: "3.3.6" },
  ]);

  assert.deepEqual(JSON.parse(bodies[0] ?? ""), { vite: ["7.1.3"], "event-stream": ["3.3.6"] });
  assert.deepEqual(advisories, [
    {
      id: "GHSA-g4jq-h2w9-997c",
      source: "npm audit",
      package: "vite",
      version: "7.1.3",
      severity: "low",
      kind: "vulnerability",
      title: "Vite's `server.fs` settings were not applied to HTML files",
      url: "https://github.com/advisories/GHSA-g4jq-h2w9-997c",
    },
    {
      id: "GHSA-mh6f-8j2x-4483",
      source: "npm audit",
      package: "event-stream",
      version: "3.3.6",
      severity: "critical",
      kind: "malware",
      title: "Critical severity vulnerability that affects event-stream and flatmap-stream",
      url: "https://github.com/advisories/GHSA-mh6f-8j2x-4483",
    },
  ]);
});

test("npm audit failures throw", async () => {
  const source = npmAuditSource(
    "https://registry.example",
    async () => new Response("", { status: 503 }),
  );

  await assert.rejects(source.check([{ name: "vite", version: "7.1.3" }]), /answered 503/);
});

test("GitHub malware advisories are asked per version through gh", async () => {
  const calls: string[][] = [];

  const source = githubMalwareSource(async (args) => {
    calls.push([...args]);

    return args.at(-1)?.includes("evil-pkg") === true
      ? JSON.stringify([
          {
            ghsa_id: "GHSA-xxxx-yyyy-zzzz",
            summary: "Malware in evil-pkg",
            severity: "critical",
            html_url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz",
          },
        ])
      : "[]";
  });

  const advisories = await source.check([
    { name: "vite", version: "7.1.3" },
    { name: "evil-pkg", version: "1.0.1" },
  ]);

  assert.deepEqual(calls[0], [
    "api",
    "--hostname",
    "github.com",
    "/advisories?type=malware&ecosystem=npm&affects=vite%407.1.3&per_page=100",
  ]);
  assert.deepEqual(advisories, [
    {
      id: "GHSA-xxxx-yyyy-zzzz",
      source: "github malware",
      package: "evil-pkg",
      version: "1.0.1",
      severity: "critical",
      kind: "malware",
      title: "Malware in evil-pkg",
      url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz",
    },
  ]);
});

test("every package version is checked once against every source; any failure fails the check", async () => {
  const asked: string[][] = [];

  const recording: AdvisorySource = {
    name: "recording",
    check: async (packages) => {
      asked.push(packages.map((pkg) => `${pkg.name}@${pkg.version}`));

      return [];
    },
  };

  const evidence = await collectAdvisories(
    [recording],
    [
      { name: "vite", version: "7.1.3" },
      { name: "esbuild", version: "0.25.9" },
      { name: "vite", version: "7.1.3" },
    ],
  );

  assert.deepEqual(evidence, { checked: ["esbuild@0.25.9", "vite@7.1.3"], advisories: [] });
  assert.deepEqual(asked, [["esbuild@0.25.9", "vite@7.1.3"]]);

  const failing: AdvisorySource = {
    name: "failing",
    check: async () => {
      throw new Error("rate limited");
    },
  };

  await assert.rejects(
    collectAdvisories([recording, failing], [{ name: "vite", version: "7.1.3" }]),
    /rate limited/,
  );
});
