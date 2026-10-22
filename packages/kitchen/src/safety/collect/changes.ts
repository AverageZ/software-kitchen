import { rm } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";

import type { Checkout } from "../../forge/forge.ts";
import { cloneAt, diffNameStatus, fetchRef, mergeBase, revParse, showFile } from "../../git.ts";
import type { ChangesEvidence } from "../evidence.ts";

import {
  diffLockfiles,
  LOCKFILE_NAMES,
  parseLockfile,
  type Importer,
  type ParsedLockfile,
} from "./lockfile.ts";
import { diffManifest } from "./manifest.ts";

/** The PR to read changes from, and a scratch directory that is deleted afterwards. */
export interface ChangesTarget {
  checkout: Checkout;
  headSha: string;
  baseRef: string;
  /** The base commit the host reports for the PR; for a merged PR, the base it merged into. */
  baseSha: string;
  workDir: string;
}

// Ancient or hand-written manifests put odd values in `engines`; those just don't declare a range.
const rootManifestSchema = z.object({
  engines: z.object({ node: z.string().optional() }).optional(),
});

/**
 * What the PR changes relative to where it branched off its base: files, manifests, lockfiles, and
 * the dependencies each workspace has at head. Reads git objects only; nothing from the PR is
 * installed or run. Throws if the head moved away from `headSha`.
 */
export async function collectChanges(target: ChangesTarget): Promise<ChangesEvidence> {
  const { checkout, headSha, workDir } = target;

  try {
    await cloneAt(checkout, workDir);

    const fetched = await fetchRef(checkout, workDir, checkout.headRef);

    if (fetched !== headSha) throw new Error(`PR head moved from ${headSha} to ${fetched}`);

    const baseTip = await fetchRef(checkout, workDir, `refs/heads/${target.baseRef}`);

    // A merged PR's head is already in the branch tip, so diff from the base the host recorded.
    // If that commit is gone (force-pushed base), the tip is the best remaining reference.
    const baseCommit = (await hasCommit(workDir, target.baseSha)) ? target.baseSha : baseTip;
    const base = await mergeBase(workDir, headSha, baseCommit);
    const files = await diffNameStatus(workDir, base, headSha);
    const headLockfiles = new Map<string, ParsedLockfile>();
    const manifests: ChangesEvidence["manifests"] = [];
    const lockfiles: ChangesEvidence["lockfiles"] = [];

    for (const file of files) {
      const name = posix.basename(file.path);
      const beforePath = file.previousPath ?? file.path;

      if (name === "package.json") {
        manifests.push(
          diffManifest(
            file.path,
            await showFile(workDir, base, beforePath),
            await showFile(workDir, headSha, file.path),
          ),
        );
      }

      if (!LOCKFILE_NAMES.includes(name)) continue;

      const beforeText = await showFile(workDir, base, beforePath);
      const afterText = await showFile(workDir, headSha, file.path);
      const before = beforeText === null ? null : parseLockfile(beforePath, beforeText);
      const after = afterText === null ? null : parseLockfile(file.path, afterText);

      if (after !== null) {
        headLockfiles.set(file.path, after);
        lockfiles.push(diffLockfiles(file.path, before, after));
      } else if (before !== null) {
        // A deleted lockfile removes everything it locked.
        lockfiles.push({
          path: file.path,
          format: before.format,
          lockfileVersion: before.lockfileVersion,
          added: [],
          removed: before.packages,
          integrityChanged: [],
        });
      }
    }

    const rootLockfile = await readRootLockfile(workDir, headSha, headLockfiles);

    if (rootLockfile !== null) headLockfiles.set(rootLockfile.path, rootLockfile.lock);

    const rootManifest = await showFile(workDir, headSha, "package.json");

    const engines =
      rootManifest === null ? null : rootManifestSchema.safeParse(JSON.parse(rootManifest));

    return {
      mergeBaseSha: base,
      headSha,
      files,
      manifests,
      lockfiles,
      importers: headImporters(headLockfiles),
      projectNodeEngine: engines?.success === true ? (engines.data.engines?.node ?? null) : null,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function hasCommit(repoDir: string, sha: string): Promise<boolean> {
  try {
    await revParse(repoDir, sha);

    return true;
  } catch {
    return false;
  }
}

interface RootLockfile {
  path: string;
  lock: ParsedLockfile;
}

/** The first lockfile at the repository root, reusing one already parsed. */
async function readRootLockfile(
  workDir: string,
  headSha: string,
  parsed: ReadonlyMap<string, ParsedLockfile>,
): Promise<RootLockfile | null> {
  for (const path of LOCKFILE_NAMES) {
    const known = parsed.get(path);

    if (known !== undefined) return { path, lock: known };

    const text = await showFile(workDir, headSha, path);

    if (text !== null) return { path, lock: parseLockfile(path, text) };
  }

  return null;
}

/** Importers of every lockfile, with paths relative to the repository root, one per directory. */
function headImporters(lockfiles: ReadonlyMap<string, ParsedLockfile>): Importer[] {
  const byPath = new Map<string, Importer>();

  for (const [lockPath, lock] of lockfiles) {
    const dir = posix.dirname(lockPath);

    for (const importer of lock.importers) {
      const path = posix.normalize(posix.join(dir, importer.path));

      if (!byPath.has(path)) byPath.set(path, { path, dependencies: importer.dependencies });
    }
  }

  return [...byPath.values()].toSorted((a, b) => (a.path < b.path ? -1 : 1));
}
