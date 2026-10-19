import { Mastra } from "@mastra/core/mastra";

import { helloWorld } from "./workflows/hello-world.ts";

export const mastra = new Mastra({
  workflows: { helloWorld },
});
