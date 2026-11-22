export const SELF_IMPROVE_EVALUATOR_CHECK = Object.freeze({
  criterionId: "SELF-IMPROVE-HEAD-INFRASTRUCTURE-TESTS",
  command: "node --test scripts/test/self-improve-pr.test.mjs",
  evaluationScope: "HEAD_INFRASTRUCTURE_ONLY",
  args: Object.freeze(["--test", "scripts/test/self-improve-pr.test.mjs"]),
  timeoutMs: 5 * 60 * 1000,
  maxOutputBytes: 10 * 1024 * 1024 - 1024,
  maxArtifactBytes: 10 * 1024 * 1024,
  maxEvidenceBytes: 1024 * 1024,
});

export const SELF_IMPROVE_RECEIPT_CRITERIA = Object.freeze({
  [SELF_IMPROVE_EVALUATOR_CHECK.criterionId]: Object.freeze({
    command: SELF_IMPROVE_EVALUATOR_CHECK.command,
    evaluationScope: SELF_IMPROVE_EVALUATOR_CHECK.evaluationScope,
  }),
});
