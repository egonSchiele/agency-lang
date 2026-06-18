const EVAL_ARTIFACT_ID_RE = /^[A-Za-z0-9._-]+$/;

export function assertEvalRunId(runId: string): void {
  assertEvalArtifactId("runId", runId);
}

export function assertEvalInputId(inputId: string): void {
  assertEvalArtifactId("id", inputId);
}

function assertEvalArtifactId(fieldName: "runId" | "id", value: string): void {
  if (!EVAL_ARTIFACT_ID_RE.test(value)) {
    throw new Error(`Invalid ${fieldName} "${value}"; use only letters, numbers, '.', '_' and '-'`);
  }
}
