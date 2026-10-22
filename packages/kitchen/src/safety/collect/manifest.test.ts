import assert from "node:assert/strict";
import { test } from "node:test";

import { diffManifest } from "./manifest.ts";

const BEFORE = JSON.stringify({
  name: "app",
  version: "1.0.0",
  scripts: { test: "vitest run", build: "vite build" },
  engines: { node: ">=22" },
  dependencies: { zod: "^4.6.0" },
  devDependencies: { vite: "^7.1.0", typescript: "7.0.2" },
  files: ["dist"],
});

function manifest(changes: Record<string, Record<string, string> | string[]>): string {
  return JSON.stringify({ ...JSON.parse(BEFORE), ...changes });
}

test("a range bump is a dependency change in its section and nothing else", () => {
  assert.deepEqual(
    diffManifest(
      "package.json",
      BEFORE,
      manifest({ devDependencies: { vite: "^7.1.2", typescript: "7.0.2" } }),
    ),
    {
      path: "package.json",
      dependencyChanges: [{ name: "vite", type: "devDependency", from: "^7.1.0", to: "^7.1.2" }],
      otherChanges: [],
    },
  );
});

test("added and removed dependencies, in every section", () => {
  const change = diffManifest(
    "web/package.json",
    BEFORE,
    manifest({
      dependencies: {},
      optionalDependencies: { fsevents: "^2.3.3" },
      peerDependencies: { react: "^19.0.0" },
    }),
  );

  assert.deepEqual(change.dependencyChanges, [
    { name: "zod", type: "dependency", from: "^4.6.0", to: null },
    { name: "fsevents", type: "optionalDependency", from: null, to: "^2.3.3" },
    { name: "react", type: "peerDependency", from: null, to: "^19.0.0" },
  ]);
  assert.deepEqual(change.otherChanges, []);
});

test("every other changed field is reported by its dotted path", () => {
  const change = diffManifest(
    "package.json",
    BEFORE,
    manifest({
      scripts: { test: "vitest run", build: "vite build", postinstall: "node setup.js" },
      engines: { node: ">=24" },
      files: ["dist", "bin"],
      pnpm: {},
    }),
  );

  assert.deepEqual(change.otherChanges, ["engines.node", "files", "pnpm", "scripts.postinstall"]);
  assert.deepEqual(change.dependencyChanges, []);
});

test("a new manifest adds all its dependencies and fields; a deleted one removes them", () => {
  const added = diffManifest("package.json", null, BEFORE);

  assert.equal(added.dependencyChanges.length, 3);
  assert.ok(added.otherChanges.includes("scripts.test"));

  const removed = diffManifest("package.json", BEFORE, null);

  assert.ok(removed.dependencyChanges.every((dependency) => dependency.to === null));
  assert.ok(removed.otherChanges.includes("name"));
});
