import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { repoSlug, type ForgeKind, type RepoRef } from "./forge/forge.ts";
import {
  policyOverrideSchema,
  resolvePolicy,
  type Policy,
  type PolicyOverride,
} from "./safety/policy.ts";

const githubAppSchema = z.strictObject({
  appId: z.union([z.string(), z.number()]).transform(String),
  /** PEM private key of the merge app. Only `kitchen merge` reads it. */
  privateKeyPath: z.string(),
});

export type GitHubAppConfig = z.infer<typeof githubAppSchema>;

const configSchema = z
  .object({
    /** Extra dependency-bot logins per host, e.g. `{ "gitlab.acme.dev": ["renovate-bot"] }`. */
    bots: z.record(z.string(), z.array(z.string())).default({}),
    /** Safety policy overrides: `default` applies everywhere, `repos` per `host/project`. */
    safety: z
      .strictObject({
        default: policyOverrideSchema.optional(),
        repos: z.record(z.string(), policyOverrideSchema).default({}),
      })
      .default({ repos: {} }),
    /** The GitHub App `kitchen merge` approves and merges as, per host. */
    githubApps: z.record(z.string(), githubAppSchema).default({}),
  })
  .strict();

/** Owner settings from `config.json` in the kitchen home. Every field is optional. */
export interface KitchenConfig {
  bots: ReadonlyMap<string, readonly string[]>;
  /** Overrides applied to every repository's policy, in order. */
  safetyDefault: PolicyOverride | null;
  /** Per-repository overrides, keyed `host/project`, applied after `safetyDefault`. */
  safetyRepos: ReadonlyMap<string, PolicyOverride>;
  githubApps: ReadonlyMap<string, GitHubAppConfig>;
}

export const EMPTY_CONFIG: KitchenConfig = {
  bots: new Map(),
  safetyDefault: null,
  safetyRepos: new Map(),
  githubApps: new Map(),
};

/** Reads `path`; a missing file is an empty config. Throws if a policy is invalid or unsafe. */
export function loadConfig(path: string): KitchenConfig {
  if (!existsSync(path)) return EMPTY_CONFIG;

  const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));

  if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);

  const config: KitchenConfig = {
    bots: new Map(Object.entries(parsed.data.bots)),
    safetyDefault: parsed.data.safety.default ?? null,
    safetyRepos: new Map(Object.entries(parsed.data.safety.repos)),
    githubApps: new Map(Object.entries(parsed.data.githubApps)),
  };

  try {
    checkCredentialSeparation(config);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return config;
}

/**
 * Untrusted PR code must never run on a host that holds merge credentials. With a GitHub App
 * configured here, every policy must leave local install and tests off; CI does the testing.
 * Also resolves every policy once, so a typo in any override fails at load.
 */
function checkCredentialSeparation(config: KitchenConfig): void {
  const scopes = [
    ["safety.default", resolvePolicy(defaultOverrides(config))] as const,
    ...[...config.safetyRepos.keys()].map(
      (slug) => [`safety.repos["${slug}"]`, resolvePolicyFor(config, slug)] as const,
    ),
  ];

  if (config.githubApps.size === 0) return;

  const running = scopes.flatMap(([scope, policy]) =>
    policy.verification.localTests ? [scope] : [],
  );

  if (running.length > 0) {
    throw new Error(
      `githubApps holds merge credentials on this host, so PR code must not run here; set verification.localTests to false in ${running.join(", ")}`,
    );
  }
}

function defaultOverrides(config: KitchenConfig): PolicyOverride[] {
  return config.safetyDefault === null ? [] : [config.safetyDefault];
}

function resolvePolicyFor(config: KitchenConfig, slug: string): Policy {
  const repo = config.safetyRepos.get(slug);

  return resolvePolicy([...defaultOverrides(config), ...(repo === undefined ? [] : [repo])]);
}

/** The safety policy for `repo`: the default, then `safety.default`, then the repo's own overrides. */
export function policyFor(config: KitchenConfig, repo: RepoRef): Policy {
  return resolvePolicyFor(config, repoSlug(repo));
}

/**
 * Dependency bots every host of a kind trusts, in the form the adapters report logins. The `[bot]`
 * suffix can't appear in a user's login, so a person can't pose as one of these.
 */
const BUILT_IN_BOTS = {
  github: ["dependabot[bot]", "renovate[bot]"],
  gitlab: [],
} as const satisfies Record<ForgeKind, readonly string[]>;

/**
 * Logins trusted to open dependency updates on `repo`'s host. Configured bots apply only to the
 * host they're listed under: a login that's a bot on one host may be anyone on another.
 */
export function dependencyBots(config: KitchenConfig, repo: RepoRef): readonly string[] {
  return [...BUILT_IN_BOTS[repo.forge], ...(config.bots.get(repo.host) ?? [])];
}
