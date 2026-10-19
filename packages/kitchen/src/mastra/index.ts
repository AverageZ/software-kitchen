import { join } from "node:path";

import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";

import { clefFlash } from "../decider.ts";
import { ghGitHub } from "../github/gh.ts";
import { kitchenHome } from "../home.ts";

import { createDependabotBump } from "./workflows/dependabot-bump.ts";
import { helloWorld } from "./workflows/hello-world.ts";

const home = kitchenHome();

export const dependabotBump = createDependabotBump({
  github: ghGitHub,
  decider: clefFlash,
  workRoot: join(home, "work"),
  now: () => new Date(),
});

export const mastra = new Mastra({
  workflows: { helloWorld, dependabotBump: dependabotBump.workflow },
  // Runs persist here so a suspended run can resume from another process (`kitchen tick`).
  storage: new LibSQLStore({ id: "kitchen", url: `file:${join(home, "mastra.db")}` }),
});
