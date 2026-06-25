import type { Grade } from "./types.js";

/** Build a scalar grade (0..1) with optional feedback.
 *  `scalar(0.7, "close")` instead of `{ score: { kind: "scalar", value: 0.7 }, feedback: "close" }`. */
export function scalar(value: number, feedback?: string): Grade {
  return { score: { kind: "scalar", value }, ...(feedback !== undefined ? { feedback } : {}) };
}

/** Build a binary pass/fail grade with optional feedback.
 *  `binary(true, "exact match")` instead of `{ score: { kind: "binary", pass: true }, feedback: "exact match" }`. */
export function binary(pass: boolean, feedback?: string): Grade {
  return { score: { kind: "binary", pass }, ...(feedback !== undefined ? { feedback } : {}) };
}
