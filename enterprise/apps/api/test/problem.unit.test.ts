import { describe, expect, test } from "vitest";

import {
  conflict,
  forbidden,
  notFound,
  runtimeAccessLost,
  serviceUnavailable,
  unauthenticated,
  validationFailed,
} from "../src/problem.js";

describe("API problem cause contract", () => {
  test.each([
    ["unauthenticated", unauthenticated],
    ["forbidden", forbidden],
    ["notFound", notFound],
    ["runtimeAccessLost", runtimeAccessLost],
    ["validationFailed", validationFailed],
    ["conflict", conflict],
    ["serviceUnavailable", serviceUnavailable],
  ] as const)("preserves ErrorOptions through %s", (_name, createProblem) => {
    const cause = new Error("problem-cause-sentinel");

    const problem = createProblem({ cause });

    expect(problem.cause).toBe(cause);
  });
});
