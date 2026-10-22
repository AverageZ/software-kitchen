import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { extractReleaseNotes, RELEASE_NOTES_LIMIT } from "./release-notes.ts";

// Shaped like renovatebot/renovate PR bodies.
const RENOVATE_BODY = `This PR contains the following updates:

| Package | Change | Age | Confidence |
|---|---|---|---|
| [vite](https://vite.dev) ([source](https://redirect.github.com/vitejs/vite/tree/HEAD/packages/vite)) | [\`7.1.2\` → \`7.1.3\`](https://renovatebot.com/diffs/npm/vite/7.1.2/7.1.3) | ![age](https://developer.mend.io/api/mc/badges/age/npm/vite/7.1.3?slim=true) | ![confidence](https://developer.mend.io/api/mc/badges/confidence/npm/vite/7.1.2/7.1.3?slim=true) |

---

### Release Notes

<details>
<summary>vitejs/vite (vite)</summary>

### [\`v7.1.3\`](https://redirect.github.com/vitejs/vite/blob/HEAD/packages/vite/CHANGELOG.md#713-2025-08-26-small)

[Compare Source](https://redirect.github.com/vitejs/vite/compare/v7.1.2...v7.1.3)

##### Bug Fixes

-   **deps:** update all non-major dependencies &amp; types ([#20587](https://redirect.github.com/vitejs/vite/issues/20587))
-   **css:** respect \`css.lightningcss\` &lt;option&gt;

</details>

---

### Configuration

📅 **Schedule**: Branch creation - At any time (no schedule defined).

<!--renovate-debug:eyJjcmVhdGVkSW5WZXIiOiI0MS4wLjAifQ==-->
`;

// Shaped like a Dependabot PR body.
const DEPENDABOT_BODY = `Bumps [vite](https://github.com/vitejs/vite/tree/HEAD/packages/vite) from 7.1.2 to 7.1.3.
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/vitejs/vite/releases">vite's releases</a>.</em></p>
<blockquote>
<h2>v7.1.3</h2>
<p>Please refer to <a href="https://github.com/vitejs/vite/blob/v7.1.3/packages/vite/CHANGELOG.md">CHANGELOG.md</a> for details.</p>
</blockquote>
</details>
<details>
<summary>Changelog</summary>
<p>Not release notes.</p>
</details>
<details>
<summary>Commits</summary>
<ul><li>abc123 release: v7.1.3</li></ul>
</details>
`;

test("Renovate's release notes run from their heading to the next rule, as plain text", () => {
  const notes = extractReleaseNotes(RENOVATE_BODY);

  assert.ok(notes !== null);
  assert.equal(notes.origin, "pr body");
  assert.equal(notes.digest, createHash("sha256").update(notes.text).digest("hex"));
  assert.ok(notes.text.startsWith("vitejs/vite (vite)"));
  assert.ok(notes.text.includes("update all non-major dependencies & types"));
  assert.ok(notes.text.includes("respect `css.lightningcss` <option>"));
  assert.ok(!notes.text.includes("Schedule"), "stops before the configuration section");
  assert.ok(!notes.text.includes("<details>"));
  assert.ok(!notes.text.includes("\n\n\n"));
});

test("Dependabot's release notes are the Release notes details block only", () => {
  const notes = extractReleaseNotes(DEPENDABOT_BODY);

  assert.ok(notes !== null);
  assert.equal(
    notes.text,
    "Sourced from vite's releases .\n\nv7.1.3\nPlease refer to CHANGELOG.md for details.",
  );
});

test("no notes section, or an empty one, is no notes", () => {
  assert.equal(extractReleaseNotes("Bumps vite from 7.1.2 to 7.1.3."), null);
  assert.equal(extractReleaseNotes("### Release Notes\n\n<details></details>\n\n---\n"), null);
});

test("long notes are capped", () => {
  const long = `### Release Notes\n\n${"word ".repeat(5000)}\n---\n`;

  assert.equal(extractReleaseNotes(long)?.text.length, RELEASE_NOTES_LIMIT);
});
