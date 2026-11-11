import { color } from "../utils/termcolors.js";
import type { EffectSetInfo } from "./effectSets.js";

// How much an approval prompt should catch the eye, so a person sees at a
// glance what kind of action they are asked about. The approval prompt
// colors the effect name by this.

export type EffectRisk = "read" | "change" | "danger";

/** The built-in effect sets that decide an effect's risk. A set made of
 *  other sets (FileSystem, Github) is left out: its members are already
 *  in one of these. A test in effectRisk.test.ts fails when a built-in set
 *  has members that no row here covers. */
export const RISK_BY_SET: Record<string, EffectRisk> = {
  FileRead: "read",
  NotesRead: "read",
  FileWrite: "change",
  NotesWrite: "change",
  Network: "change",
  AwsS3: "change",
  Calendar: "change",
  Memory: "change",
  Shell: "danger",
  Secrets: "danger",
  Messaging: "danger",
  Auth: "danger",
};

/** An effect in none of those sets, a program's own effects among them. */
const DEFAULT_RISK: EffectRisk = "change";

const RANK: EffectRisk[] = ["read", "change", "danger"];

/** Bold, in the color for each risk. */
export const RISK_COLOR: Record<EffectRisk, (text: string) => string> = {
  read: color.bold.green,
  change: color.bold.yellow,
  danger: color.bold.red,
};

/** The highest risk among the sets `effect` belongs to, or the default
 *  when it belongs to none of them. */
export function effectRisk(effect: string, sets: Record<string, EffectSetInfo>): EffectRisk {
  const risks = Object.keys(RISK_BY_SET)
    .filter((name) => sets[name]?.members.includes(effect) === true)
    .map((name) => RISK_BY_SET[name]);
  if (risks.length === 0) {
    return DEFAULT_RISK;
  }
  return RANK[Math.max(...risks.map((risk) => RANK.indexOf(risk)))];
}
