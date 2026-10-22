import type { SafetyAssessment } from "../../safety/assessment.ts";
import type { Tests } from "../../safety/evidence.ts";

/** First line of the kitchen's comment; reruns edit the comment that starts with it. */
export const COMMENT_MARKER = "<!-- software-kitchen:dependabot-bump -->";

export interface CommentFacts {
  assessment: SafetyAssessment;
  /** Null when the policy turned local tests off. */
  tests: Tests | null;
}

const DECISION_TEXT = {
  AUTO_MERGE: "safe to merge unattended",
  INVESTIGATE: "needs investigation",
  HUMAN_REVIEW: "needs a human review",
  DEFER: "deferred: a temporary condition must clear first",
  BLOCK: "blocked: do not merge",
  INSUFFICIENT_EVIDENCE: "insufficient evidence to grade",
} as const satisfies Record<SafetyAssessment["decision"], string>;

/** One table cell: no pipes or newlines. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll(/\s*\n\s*/g, " ");
}

function actionLine(assessment: SafetyAssessment): string {
  const { authorization } = assessment;

  if (assessment.decision !== "AUTO_MERGE") return "Nothing was approved or merged.";

  if (authorization.permitted)
    return `Queued for \`kitchen merge\`, which revalidates the PR and merges commit \`${assessment.headSha.slice(0, 7)}\` with the merge app${authorization.approve ? " after approving it" : ""}.`;

  return `Not merging: ${authorization.reasons.join("; ")}.`;
}

export function renderComment(facts: CommentFacts): string {
  const { assessment, tests } = facts;
  const classification = assessment.updateClassification;

  const grade =
    assessment.grade === null || assessment.score === null
      ? "no grade"
      : `grade ${assessment.grade} (${assessment.score}/100)`;

  const lines = [
    COMMENT_MARKER,
    `### Software Kitchen: \`${assessment.dependency ?? "?"}\` ${assessment.previousVersion ?? "?"} → ${assessment.proposedVersion ?? "?"} (${classification.updateType}${classification.dependencyType === null ? "" : `, ${classification.dependencyType}`})`,
    "",
    `**${assessment.decision}**: ${DECISION_TEXT[assessment.decision]} · ${grade} · policy \`${assessment.policyVersion}\` · ${assessment.authorization.mode} mode · commit \`${assessment.headSha.slice(0, 7)}\``,
    "",
    actionLine(assessment),
    "",
    ...assessment.explanation.map((line) => `- ${line}`),
  ];

  if (!assessment.eligible) {
    lines.push(
      "",
      `Outside the scope for unattended merging (this is not a judgement that it's unsafe): ${assessment.eligibilityReasons.join("; ")}.`,
    );
  }

  if (assessment.gates.length > 0) {
    lines.push("", "| Gate | Result | Why |", "| --- | --- | --- |");

    for (const gate of assessment.gates) {
      const result =
        gate.disposition === null ? gate.status : `${gate.status} (${gate.disposition})`;

      lines.push(`| ${gate.gate} | ${result} | ${cell(gate.reasons.join("; ") || "–")} |`);
    }
  }

  if (assessment.findings.length > 0) {
    lines.push("", "| Finding | Points | Evidence | Why |", "| --- | --- | --- | --- |");

    // Each deduction is charged to the first finding of its root that names the deducted criterion.
    const charged = new Map(
      assessment.deductions.flatMap((deduction) => {
        const first = deduction.findings.find(
          (id) =>
            assessment.findings.find((finding) => finding.id === id)?.criterion ===
            deduction.criterion,
        );

        return first === undefined ? [] : [[first, deduction.points] as const];
      }),
    );

    for (const finding of assessment.findings) {
      const points = charged.get(finding.id);
      const cost = points === undefined || points === 0 ? "0" : `−${points}`;

      lines.push(
        `| ${finding.criterion} | ${cost} | ${finding.evidence.join(", ")} | ${cell(finding.explanation)} |`,
      );
    }
  }

  if (assessment.rejectedFindings.length > 0) {
    lines.push("", "Model findings the evaluator refused:");

    for (const { finding, reason } of assessment.rejectedFindings)
      lines.push(`- ${finding.criterion} on ${finding.component}: ${reason}`);
  }

  if (assessment.missingEvidence.length > 0)
    lines.push("", `Missing evidence: ${assessment.missingEvidence.join("; ")}.`);

  lines.push(
    "",
    "<details><summary>Evidence</summary>",
    "",
    "| Item | Status | Source | Commit |",
    "| --- | --- | --- | --- |",
  );

  for (const item of assessment.evidence) {
    const status = item.reason === null ? item.status : `${item.status}: ${item.reason}`;

    lines.push(
      `| ${item.id} | ${cell(status)} | ${cell(item.source)} | ${item.sha?.slice(0, 7) ?? "–"} |`,
    );
  }

  lines.push("", "</details>");

  if (tests !== null && tests.log.trim() !== "") {
    lines.push(
      "",
      `<details><summary>Test log (tail)${tests.command === null ? "" : `: \`${tests.command}\``}</summary>`,
      "",
      "````text",
      tests.log.trimEnd(),
      "````",
      "",
      "</details>",
    );
  }

  return lines.join("\n");
}
