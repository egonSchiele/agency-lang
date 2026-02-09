import { AgencyNode } from "@/types.js";

export type TimeBlock = {
  type: "timeBlock";
  body: AgencyNode[];
  printTime?: boolean;
};
