import { createHash } from "node:crypto";

import type { ReleaseNotesEvidence } from "../evidence.ts";

/** Longest notes kept: enough for a patch's changelog, bounded for the model's context. */
export const RELEASE_NOTES_LIMIT = 6000;

const ENTITIES = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&nbsp;", " "],
]);

/** Renovate: from its `### Release Notes` heading to the next `---` rule or `### Configuration`. */
function renovateSection(body: string): string | null {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === "### Release Notes");

  if (start === -1) return null;

  const rest = lines.slice(start + 1);

  const end = rest.findIndex(
    (line) => line.trim() === "---" || line.trim().startsWith("### Configuration"),
  );

  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

const DEPENDABOT_NOTES =
  /<details>\s*<summary>\s*Release notes\s*<\/summary>([\s\S]*?)<\/details>/i;

/** Markup removed and whitespace collapsed: one line per line of text, no blank runs. */
function plainText(markup: string): string {
  const text = markup
    .replaceAll(/<!--[\s\S]*?-->/g, "")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES.get(entity) ?? entity);

  return text
    .split("\n")
    .map((line) => line.replaceAll(/\s+/g, " ").trim())
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The release notes Renovate or Dependabot quoted in the PR body, as plain text capped at
 * `RELEASE_NOTES_LIMIT`, with a digest so findings can cite exactly what was read. Null when the
 * body has no notes section or it is empty.
 */
export function extractReleaseNotes(body: string): ReleaseNotesEvidence | null {
  const section = renovateSection(body) ?? DEPENDABOT_NOTES.exec(body)?.[1] ?? null;

  if (section === null) return null;

  const text = plainText(section).slice(0, RELEASE_NOTES_LIMIT);

  if (text === "") return null;

  return {
    origin: "pr body",
    digest: createHash("sha256").update(text).digest("hex"),
    text,
  };
}
