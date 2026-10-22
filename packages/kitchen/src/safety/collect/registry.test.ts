import assert from "node:assert/strict";
import { test } from "node:test";

import type { LockedPackage } from "../evidence.ts";

import { collectRegistry, createNpmRegistry, TRANSITIVE_LIMIT, type FetchFn } from "./registry.ts";

const VITE = {
  name: "vite",
  "dist-tags": { latest: "7.1.3" },
  maintainers: [
    { name: "yyx990803", email: "e@x" },
    { name: "patak", email: "p@x" },
  ],
  time: {
    created: "2020-04-21T00:00:00.000Z",
    modified: "2025-09-01T00:00:00.000Z",
    "6.3.5": "2025-05-05T00:00:00.000Z",
    "7.1.2": "2025-08-12T00:00:00.000Z",
    "8.0.0-beta.1": "2025-08-20T00:00:00.000Z",
    "7.1.3": "2025-08-26T00:00:00.000Z",
  },
  versions: {
    "7.1.2": {
      name: "vite",
      version: "7.1.2",
      dependencies: { esbuild: "^0.25.0" },
      peerDependencies: { "@types/node": "^20.19.0 || >=22.12.0" },
      peerDependenciesMeta: { "@types/node": { optional: true } },
      engines: { node: "^20.19.0 || >=22.12.0" },
      scripts: { build: "rollup -c", postinstall: "node check.js" },
      _npmUser: { name: "patak", email: "p@x" },
      maintainers: [
        { name: "patak", email: "p@x" },
        { name: "yyx990803", email: "e@x" },
      ],
      dist: {
        integrity: "sha512-vite712",
        tarball: "https://registry.npmjs.org/vite/-/vite-7.1.2.tgz",
        attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/vite@7.1.2" },
      },
    },
    "7.1.3": {
      name: "vite",
      version: "7.1.3",
      dependencies: { esbuild: "^0.25.0", picomatch: "^4.0.3" },
      engines: ["node >= 0.4"],
      _npmUser: { name: "patak", email: "p@x" },
      dist: {
        integrity: "sha512-vite713",
        tarball: "https://registry.npmjs.org/vite/-/vite-7.1.3.tgz",
      },
      deprecated: "use 7.1.4",
    },
  },
};

/** A one-version packument, as JSON. */
function packument(name: string, version: string, scripts: Record<string, string> = {}): string {
  return JSON.stringify({
    name,
    time: { [version]: "2025-01-01T00:00:00.000Z" },
    versions: {
      [version]: { name, version, scripts, dist: { integrity: `sha512-${name}` } },
    },
  });
}

/** A fetch that serves JSON `documents` by URL path and records every URL asked for. */
function fakeFetch(documents: ReadonlyMap<string, string>, requested: string[]): FetchFn {
  return async (input) => {
    const url = new URL(String(input));

    requested.push(url.pathname);

    if (url.pathname === "/broken") return new Response("oops", { status: 500 });

    const document = documents.get(url.pathname);

    return document === undefined
      ? new Response("{}", { status: 404 })
      : new Response(document, { headers: { "content-type": "application/json" } });
  };
}

function locked(name: string, version: string): LockedPackage {
  return { name, version, integrity: null, resolved: null, hasInstallScript: false };
}

test("registry evidence maps both versions, the previous release, and the added packages", async () => {
  const requested: string[] = [];

  const registry = createNpmRegistry(
    "https://registry.example/",
    fakeFetch(
      new Map([
        ["/vite", JSON.stringify(VITE)],
        ["/picomatch", packument("picomatch", "4.0.3")],
        [
          "/@esbuild%2Fdarwin-arm64",
          packument("@esbuild/darwin-arm64", "0.25.9", {
            install: "node install.js",
            test: "jest",
          }),
        ],
      ]),
      requested,
    ),
  );

  const evidence = await collectRegistry(registry, {
    package: "vite",
    from: "7.1.2",
    to: "7.1.3",
    added: [
      locked("vite", "7.1.3"),
      locked("picomatch", "4.0.3"),
      locked("@esbuild/darwin-arm64", "0.25.9"),
    ],
  });

  assert.ok(requested.includes("/@esbuild%2Fdarwin-arm64"), "scoped names are encoded");
  assert.equal(evidence.registry, "https://registry.example");
  assert.deepEqual(evidence.from, {
    version: "7.1.2",
    publishedAt: "2025-08-12T00:00:00.000Z",
    integrity: "sha512-vite712",
    tarball: "https://registry.npmjs.org/vite/-/vite-7.1.2.tgz",
    installScripts: { postinstall: "node check.js" },
    gypfile: false,
    dependencies: { esbuild: "^0.25.0" },
    optionalDependencies: {},
    peerDependencies: { "@types/node": "^20.19.0 || >=22.12.0" },
    optionalPeers: ["@types/node"],
    engines: { node: "^20.19.0 || >=22.12.0" },
    publisher: "patak",
    maintainers: ["patak", "yyx990803"],
    provenance: true,
    deprecated: null,
  });
  assert.equal(evidence.to?.engines.node, null, "an engines array declares no range");
  assert.deepEqual(evidence.to?.maintainers, ["patak", "yyx990803"], "falls back to the package's");
  assert.equal(evidence.to?.provenance, false);
  assert.equal(evidence.to?.deprecated, "use 7.1.4");
  assert.deepEqual(
    evidence.previousRelease,
    { version: "7.1.2", publishedAt: "2025-08-12T00:00:00.000Z" },
    "prereleases and created/modified don't count",
  );
  assert.deepEqual(evidence.transitive, [
    {
      name: "@esbuild/darwin-arm64",
      version: "0.25.9",
      installScripts: { install: "node install.js" },
      gypfile: false,
      integrity: "sha512-@esbuild/darwin-arm64",
      dependencies: {},
      optionalDependencies: {},
    },
    {
      name: "picomatch",
      version: "4.0.3",
      installScripts: {},
      gypfile: false,
      integrity: "sha512-picomatch",
      dependencies: {},
      optionalDependencies: {},
    },
  ]);
  assert.equal(evidence.transitiveComplete, true);
});

test("unknown packages are null and incomplete; registry failures throw", async () => {
  const registry = createNpmRegistry("https://registry.example", fakeFetch(new Map(), []));

  assert.equal(await registry.packument("left-pad"), null);
  await assert.rejects(registry.packument("broken"), /answered 500 for broken/);

  const evidence = await collectRegistry(registry, {
    package: "vite",
    from: "7.1.2",
    to: "7.1.3",
    added: [locked("ghost", "1.0.0")],
  });

  assert.equal(evidence.from, null);
  assert.equal(evidence.to, null);
  assert.equal(evidence.previousRelease, null);
  assert.deepEqual(evidence.transitive, []);
  assert.equal(evidence.transitiveComplete, false);
});

test("at most TRANSITIVE_LIMIT added packages are looked up", async () => {
  const requested: string[] = [];
  const documents = new Map([["/vite", JSON.stringify(VITE)]]);
  const added: LockedPackage[] = [];

  for (let index = 0; index < TRANSITIVE_LIMIT + 5; index += 1) {
    const name = `dep-${String(index).padStart(3, "0")}`;

    documents.set(`/${name}`, packument(name, "1.0.0"));
    added.push(locked(name, "1.0.0"));
  }

  const registry = createNpmRegistry("https://registry.example", fakeFetch(documents, requested));

  const evidence = await collectRegistry(registry, {
    package: "vite",
    from: "7.1.2",
    to: "7.1.3",
    added,
  });

  assert.equal(evidence.transitive.length, TRANSITIVE_LIMIT);
  assert.equal(requested.length, TRANSITIVE_LIMIT + 1);
  assert.equal(evidence.transitiveComplete, false);
});
