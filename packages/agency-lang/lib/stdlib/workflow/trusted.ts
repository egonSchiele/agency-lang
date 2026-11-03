/**
 * The only callers that compile against the trusted-modules list
 * (docs/dev/runtime/trusted-modules.md). `stdlib/workflow.agency` imports
 * these from TypeScript, a path sandboxed code cannot import, so a trusted
 * module is reachable only through a tool list the host passed to
 * `std::workflow`. The public `compile`, `typecheck`, and `describe` in
 * `std::agency` pass an empty list.
 *
 * None of them takes a list: each reads the one this process was given
 * (the config at the root, the parent's in a subprocess), so no caller can
 * widen it.
 */
import { currentRun } from "../../runtime/asyncContext.js";
import {
  compileWithTrustedModules,
  describeWithTrustedModules,
  effectiveTrustedModules,
  typecheckWithTrustedModules,
} from "../agency.js";

export function _compileTrusted(source: string, dir: string, strict: boolean) {
  const trusted = effectiveTrustedModules(currentRun().ctx);
  return compileWithTrustedModules(source, dir, strict, trusted);
}

export function _typecheckTrusted(source: string, dir: string, strict: boolean) {
  const trusted = effectiveTrustedModules(currentRun().ctx);
  return typecheckWithTrustedModules(source, dir, strict, trusted);
}

export function _describeTrusted(source: string, dir: string, filename: string) {
  const trusted = effectiveTrustedModules(currentRun().ctx);
  return describeWithTrustedModules(source, dir, filename, trusted);
}
