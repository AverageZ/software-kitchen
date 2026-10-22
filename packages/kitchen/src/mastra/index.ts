import { join } from "node:path";

import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";

import { loadConfig, policyFor } from "../config.ts";
import { clefFlash } from "../decider.ts";
import { createForges } from "../forge/forges.ts";
import { kitchenHome } from "../home.ts";
import { githubMalwareSource, npmAuditSource } from "../safety/collect/advisories.ts";
import { createNpmRegistry } from "../safety/collect/registry.ts";

import { createDependabotBump } from "./workflows/dependabot-bump.ts";
import { helloWorld } from "./workflows/hello-world.ts";

const home = kitchenHome();

/** Owner settings from `config.json` in the kitchen home. */
export const config = loadConfig(join(home, "config.json"));

/** Every host the kitchen reaches. Reads only with the owner's own `gh`/`glab` logins; never merges. */
export const forge = createForges(config);

/** Where evidence about packages comes from: the policy's npm registry and two advisory databases. */
export const evidenceSources = {
  registry: (baseUrl: string) => createNpmRegistry(baseUrl),
  advisories: (registryUrl: string) => [npmAuditSource(registryUrl), githubMalwareSource()],
};

export const dependabotBump = createDependabotBump({
  forge,
  decider: clefFlash,
  policy: (repo) => policyFor(config, repo),
  ...evidenceSources,
  workRoot: join(home, "work"),
  now: () => new Date(),
});

export const mastra = new Mastra({
  workflows: { helloWorld, dependabotBump: dependabotBump.workflow },
  // Runs persist here so a suspended run can resume from another process (`kitchen tick`).
  storage: new LibSQLStore({ id: "kitchen", url: `file:${join(home, "mastra.db")}` }),
});
