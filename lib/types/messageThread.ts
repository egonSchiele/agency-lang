import { AgencyNode } from "@/types.js";

export type MessageThread = {
  type: "messageThread";
  subthread: boolean;
  body: AgencyNode[];
};
