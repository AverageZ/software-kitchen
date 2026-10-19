import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

const greet = createStep({
  id: "greet",
  description: "Builds a greeting for the given name.",
  inputSchema: z.object({ name: z.string().min(1) }),
  outputSchema: z.object({ greeting: z.string() }),
  execute: async ({ inputData }) => ({ greeting: `Hello, ${inputData.name}!` }),
});

export const helloWorld = createWorkflow({
  id: "hello-world",
  description: "Skeleton workflow: proves Mastra runs a typed step end to end.",
  inputSchema: z.object({ name: z.string().min(1) }),
  outputSchema: z.object({ greeting: z.string() }),
})
  .then(greet)
  .commit();
