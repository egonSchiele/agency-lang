import type { Frame } from "../frame.js";
import { flatten } from "./flatten.js";

export function toPlainText(frame: Frame): string {
  const grid = flatten(frame, frame.width, frame.height);
  return grid
    .map((row) => row.map((c) => c.char).join("").trimEnd())
    .join("\n");
}
