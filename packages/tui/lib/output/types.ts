import type { Frame } from "../frame.js";

export type OutputTarget = {
  write(frame: Frame, label?: string): void;
  destroy?(): void;
};
