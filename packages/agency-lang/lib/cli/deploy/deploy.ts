// Deploying an agent, top to bottom. This reads as the "what": resolve the
// target, gather the source bundle, check it compiles, then upload. Each step's
// "how" lives in its own module.

import type { AgencyConfig } from "@/config.js";
import { resolveDeployTarget } from "./target.js";
import type { DeployTarget, TargetProvenance } from "./target.js";
import { collectAgencyBundle, validateBundleCompiles } from "./bundle.js";
import type { AgencyBundle } from "./bundle.js";
import { uploadBundle } from "../statelog/uploadClient.js";
import type { ServeManifest } from "../statelog/serveClient.js";

export type DeployOptions = {
  host?: string;
  project?: string;
  apiKeyEnv?: string;
  /** Preview the plan without uploading. */
  dryRun?: boolean;
};

export type DeployPlan = {
  target: DeployTarget;
  provenance: TargetProvenance;
  bundle: AgencyBundle;
};

export type DeployOutcome =
  | { kind: "error"; error: string }
  | { kind: "preview"; plan: DeployPlan }
  | { kind: "deployed"; plan: DeployPlan; endpointUrls: string[]; manifest?: ServeManifest };

export async function deploy(
  entrypointPath: string,
  config: AgencyConfig,
  options: DeployOptions,
): Promise<DeployOutcome> {
  const target = resolveDeployTarget(config.log, options, process.env);
  if (!target.ok) {
    return { kind: "error", error: target.error };
  }

  const bundle = collectAgencyBundle(entrypointPath, config);
  if (!bundle.ok) {
    return { kind: "error", error: bundle.error };
  }

  const compiles = validateBundleCompiles(bundle.bundle, config);
  if (!compiles.ok) {
    return { kind: "error", error: compiles.error };
  }

  const plan: DeployPlan = {
    target: target.target,
    provenance: target.provenance,
    bundle: bundle.bundle,
  };

  if (options.dryRun) {
    return { kind: "preview", plan };
  }

  const uploaded = await uploadBundle(target.target, bundle.bundle);
  if (!uploaded.ok) {
    return { kind: "error", error: uploaded.error };
  }

  return {
    kind: "deployed",
    plan,
    endpointUrls: uploaded.endpointUrls,
    manifest: uploaded.manifest,
  };
}
