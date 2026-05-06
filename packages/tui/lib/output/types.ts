import type { Frame } from "../frame.js";

export type OutputTarget = {
  write(frame: Frame, label?: string): void;
  flush?(): void;
};
