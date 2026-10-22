import assert from "node:assert/strict";
import { test } from "node:test";

import { diffLockfiles, parseLockfile } from "./lockfile.ts";

const PNPM_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      zod:
        specifier: 4.6.7
        version: 4.6.7
    devDependencies:
      '@vitejs/plugin-react':
        specifier: ^5.0.0
        version: 5.0.1(vite@7.1.2(@types/node@24.3.0))
      vite:
        specifier: ^7.1.0
        version: 7.1.2(@types/node@24.3.0)

  packages/web:
    dependencies:
      shared:
        specifier: workspace:*
        version: link:../shared

packages:

  '@vitejs/plugin-react@5.0.1':
    resolution: {integrity: sha512-plugin}
    engines: {node: ^20.19.0 || >=22.12.0}
    peerDependencies:
      vite: ^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0

  esbuild@0.25.9:
    resolution: {integrity: sha512-esbuild}
    engines: {node: '>=18'}
    hasBin: true

  vite@7.1.2:
    resolution: {integrity: sha512-vite712}
    engines: {node: ^20.19.0 || >=22.12.0}
    hasBin: true

  zod@4.6.7:
    resolution: {integrity: sha512-zod}

snapshots:

  '@vitejs/plugin-react@5.0.1(vite@7.1.2(@types/node@24.3.0))':
    dependencies:
      vite: 7.1.2(@types/node@24.3.0)

  esbuild@0.25.9: {}

  vite@7.1.2(@types/node@24.3.0):
    dependencies:
      esbuild: 0.25.9

  zod@4.6.7: {}
`;

const PNPM_V6 = `lockfileVersion: '6.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

devDependencies:
  vite:
    specifier: ^5.0.0
    version: 5.0.10(@types/node@20.10.0)

packages:

  /@types/node@20.10.0:
    resolution: {integrity: sha512-types-node}
    dev: true

  /esbuild@0.19.9:
    resolution: {integrity: sha512-esbuild}
    engines: {node: '>=12'}
    hasBin: true
    requiresBuild: true
    dev: true

  /vite@5.0.10(@types/node@20.10.0):
    resolution: {integrity: sha512-vite}
    engines: {node: ^18.0.0 || >=20.0.0}
    hasBin: true
    dev: true

  /vite@5.0.10(@types/node@20.11.0):
    resolution: {integrity: sha512-vite}
    dev: true
`;

function npmLock(viteVersion: string, viteIntegrity: string): string {
  return JSON.stringify({
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "app",
        version: "1.0.0",
        workspaces: ["packages/*"],
        dependencies: { zod: "^4.6.0" },
        devDependencies: { vite: "^7.1.0" },
      },
      "node_modules/esbuild": {
        version: "0.25.9",
        resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.25.9.tgz",
        integrity: "sha512-esbuild",
        dev: true,
        hasInstallScript: true,
      },
      "node_modules/shared": { resolved: "packages/shared", link: true },
      "node_modules/vite": {
        version: viteVersion,
        resolved: `https://registry.npmjs.org/vite/-/vite-${viteVersion}.tgz`,
        integrity: viteIntegrity,
        dev: true,
      },
      "node_modules/zod": {
        version: "4.6.7",
        resolved: "https://registry.npmjs.org/zod/-/zod-4.6.7.tgz",
        integrity: "sha512-zod",
      },
      "packages/web": {
        name: "web",
        version: "0.0.0",
        dependencies: { shared: "*", zod: "^3.0.0" },
      },
      "packages/web/node_modules/zod": {
        version: "3.25.0",
        resolved: "https://registry.npmjs.org/zod/-/zod-3.25.0.tgz",
        integrity: "sha512-zod3",
      },
    },
  });
}

test("pnpm v9: packages from `packages`, importers with peer suffixes stripped and links skipped", () => {
  const lock = parseLockfile("pnpm-lock.yaml", PNPM_V9);

  assert.equal(lock.format, "pnpm");
  assert.equal(lock.lockfileVersion, "9.0");
  assert.deepEqual(
    lock.packages.map((locked) => `${locked.name}@${locked.version}`),
    ["@vitejs/plugin-react@5.0.1", "esbuild@0.25.9", "vite@7.1.2", "zod@4.6.7"],
  );
  assert.deepEqual(lock.packages[2], {
    name: "vite",
    version: "7.1.2",
    integrity: "sha512-vite712",
    resolved: null,
    hasInstallScript: null,
  });
  assert.deepEqual(lock.importers, [
    {
      path: ".",
      dependencies: [
        { name: "zod", type: "dependency", specifier: "4.6.7", version: "4.6.7" },
        {
          name: "@vitejs/plugin-react",
          type: "devDependency",
          specifier: "^5.0.0",
          version: "5.0.1",
        },
        { name: "vite", type: "devDependency", specifier: "^7.1.0", version: "7.1.2" },
      ],
    },
    { path: "packages/web", dependencies: [] },
  ]);
});

test("pnpm v6: leading slashes and peer variants collapse to one name@version; requiresBuild is read", () => {
  const lock = parseLockfile("web/pnpm-lock.yaml", PNPM_V6);

  assert.equal(lock.lockfileVersion, "6.0");
  assert.deepEqual(
    lock.packages.map((locked) => [`${locked.name}@${locked.version}`, locked.hasInstallScript]),
    [
      ["@types/node@20.10.0", null],
      ["esbuild@0.19.9", true],
      ["vite@5.0.10", null],
    ],
  );
  assert.deepEqual(lock.importers, [
    {
      path: ".",
      dependencies: [
        { name: "vite", type: "devDependency", specifier: "^5.0.0", version: "5.0.10" },
      ],
    },
  ]);
});

test("npm v3: nested node_modules name the innermost package; workspaces are importers", () => {
  const lock = parseLockfile("package-lock.json", npmLock("7.1.2", "sha512-vite712"));

  assert.equal(lock.format, "npm");
  assert.equal(lock.lockfileVersion, "3");
  assert.deepEqual(
    lock.packages.map((locked) => [`${locked.name}@${locked.version}`, locked.hasInstallScript]),
    [
      ["esbuild@0.25.9", true],
      ["vite@7.1.2", false],
      ["zod@3.25.0", false],
      ["zod@4.6.7", false],
    ],
  );
  assert.equal(lock.packages[1]?.resolved, "https://registry.npmjs.org/vite/-/vite-7.1.2.tgz");
  assert.deepEqual(lock.importers, [
    {
      path: ".",
      dependencies: [
        { name: "zod", type: "dependency", specifier: "^4.6.0", version: "4.6.7" },
        { name: "vite", type: "devDependency", specifier: "^7.1.0", version: "7.1.2" },
      ],
    },
    {
      path: "packages/web",
      dependencies: [{ name: "zod", type: "dependency", specifier: "^3.0.0", version: "3.25.0" }],
    },
  ]);
});

test("old lockfile versions and other files are refused", () => {
  assert.throws(
    () => parseLockfile("package-lock.json", JSON.stringify({ lockfileVersion: 1, packages: {} })),
    /version 1 is not supported/,
  );
  assert.throws(
    () => parseLockfile("pnpm-lock.yaml", "lockfileVersion: 5.4\n"),
    /version 5.4 is not supported/,
  );
  assert.throws(() => parseLockfile("yarn.lock", ""), /not a pnpm or npm lockfile/);
});

test("a lockfile diff lists added and removed versions, and re-pinned integrity", () => {
  const before = parseLockfile("package-lock.json", npmLock("7.1.2", "sha512-vite712"));
  const after = parseLockfile("package-lock.json", npmLock("7.1.3", "sha512-vite713"));
  const diff = diffLockfiles("package-lock.json", before, after);

  assert.deepEqual(
    diff.added.map((locked) => `${locked.name}@${locked.version}`),
    ["vite@7.1.3"],
  );
  assert.deepEqual(
    diff.removed.map((locked) => `${locked.name}@${locked.version}`),
    ["vite@7.1.2"],
  );
  assert.deepEqual(diff.integrityChanged, []);

  const repinned = parseLockfile("package-lock.json", npmLock("7.1.2", "sha512-evil"));

  assert.deepEqual(diffLockfiles("package-lock.json", before, repinned), {
    path: "package-lock.json",
    format: "npm",
    lockfileVersion: "3",
    added: [],
    removed: [],
    integrityChanged: [
      { name: "vite", version: "7.1.2", before: "sha512-vite712", after: "sha512-evil" },
    ],
  });
});

test("a new lockfile adds everything it locks", () => {
  const after = parseLockfile("pnpm-lock.yaml", PNPM_V6);
  const diff = diffLockfiles("pnpm-lock.yaml", null, after);

  assert.equal(diff.added.length, 3);
  assert.deepEqual(diff.removed, []);
});
