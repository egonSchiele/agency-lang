import { AgencyNode } from "@/types.js";

export type MessageThread = {
  type: "messageThread";
  body: AgencyNode[];
};
