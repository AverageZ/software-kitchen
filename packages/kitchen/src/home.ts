import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Directory holding the kitchen's databases and checkouts.
 *
 * Absolute so the CLI and `mastra dev` (which runs from a bundle directory) share one store.
 */
export function kitchenHome(): string {
  const home = process.env["KITCHEN_HOME"] ?? join(homedir(), ".software-kitchen");

  mkdirSync(home, { recursive: true });

  return home;
}
