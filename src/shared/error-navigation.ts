import type { ExecutionError } from "./contracts.js";

export function errorDestination(error: ExecutionError) {
  return error.variableId
    ? { kind: "variable" as const, variableId: error.variableId }
    : { kind: "step" as const, stepId: error.stepId, version: error.version };
}
