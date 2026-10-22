import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export interface CommandOptions {
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

export interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Combined stdout and stderr, keeping only the last `OUTPUT_LIMIT` characters. */
  output: string;
  stdout: string;
}

const OUTPUT_LIMIT = 200_000;

function keepTail(text: string): string {
  return text.length > OUTPUT_LIMIT ? text.slice(-OUTPUT_LIMIT) : text;
}

/** Runs a command to completion. Never throws for a non-zero exit; callers decide what failure means. */
export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let output = "";
  let stdout = "";
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;

    // Kill the whole process group: package managers spawn children that outlive the parent.
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  }, options.timeoutMs);

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = keepTail(stdout + chunk.toString());
    output = keepTail(output + chunk.toString());
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output = keepTail(output + chunk.toString());
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (exitCode) => {
    clearTimeout(timer);
    resolve({ exitCode, timedOut, output, stdout });
  });
  child.stdin.end(options.stdin ?? "");

  return promise;
}

/** Runs a command that must succeed; throws with its output otherwise. */
export async function runChecked(
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<string> {
  const result = await runCommand(command, args, options);

  if (result.timedOut)
    throw new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`);

  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.exitCode}: ${lastLines(result.output, 20)}`,
    );
  }

  return result.stdout;
}

/** The last `count` lines of command output, without terminal colour codes, for logs and comments. */
export function lastLines(text: string, count: number): string {
  return stripVTControlCharacters(text).trimEnd().split("\n").slice(-count).join("\n");
}
