import { AgencyNode } from "../types.js";
import { BaseNode } from "./base.js";

export type ParallelBlock = BaseNode & {
  type: "parallelBlock";
  body: AgencyNode[];
};

export type SeqBlock = BaseNode & {
  type: "seqBlock";
  body: AgencyNode[];
};
