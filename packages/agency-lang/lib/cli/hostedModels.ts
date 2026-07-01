import {
  _listHostedModels,
  _refreshHostedCatalog,
  type HostedModelInfo,
} from "../stdlib/llm.js";

export type ModelsListOpts = {
  provider?: string;
  maxPrice?: number;
  minContext?: number;
};

// Filter predicate mirrors the Agency `filterHostedModels` in
// lib/agents/agency-agent/lib/modelFilters.agency (the agent can't call this TS
// and vice-versa) — keep the two in sync; both are unit-tested.
export function selectHostedModels(
  all: HostedModelInfo[],
  opts: ModelsListOpts,
): HostedModelInfo[] {
  return all.filter((model) => {
    if (opts.provider && model.provider !== opts.provider) {
      return false;
    }
    if (opts.maxPrice !== undefined && model.inputCost > opts.maxPrice) {
      return false;
    }
    if (opts.minContext !== undefined && model.contextWindow < opts.minContext) {
      return false;
    }
    return true;
  });
}

// Fixed-width columns. NOTE: names longer than NAME_WIDTH are truncated in the
// table (display only — the agent picker uses the full untruncated name).
const NAME_WIDTH = 29;
const PROVIDER_WIDTH = 12;

export function formatHostedCatalog(models: HostedModelInfo[]): string {
  const header = "NAME                          PROVIDER     OPEN   $IN/1M   $OUT/1M    CTX";
  const rows = models.map((model) => {
    const name = model.name.padEnd(NAME_WIDTH).slice(0, NAME_WIDTH);
    const provider = model.provider.padEnd(PROVIDER_WIDTH).slice(0, PROVIDER_WIDTH);
    const open = (model.openWeights ? "yes" : "no").padEnd(6);
    const inCost = String(model.inputCost).padStart(7);
    const outCost = String(model.outputCost).padStart(8);
    const context = String(model.contextWindow).padStart(8);
    return `${name} ${provider} ${open} ${inCost} ${outCost} ${context}`;
  });
  return [header, ...rows].join("\n");
}

export async function modelsList(opts: ModelsListOpts): Promise<void> {
  console.log(formatHostedCatalog(selectHostedModels(_listHostedModels(), opts)));
}

export async function modelsRefresh(url?: string): Promise<void> {
  const res = await _refreshHostedCatalog(url ?? "");
  if (res.ok) {
    console.log(`Refreshed hosted model catalog (${res.count} models).`);
  } else {
    console.error(`Refresh failed: ${res.error}`);
    process.exitCode = 1;
  }
}
