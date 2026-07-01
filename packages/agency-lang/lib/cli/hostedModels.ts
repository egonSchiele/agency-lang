import {
  _listHostedModels,
  _fetchModelData,
  _loadModelData,
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

// Optional `files` are model-data JSON files (as printed by `agency models
// refresh`) to load into this process before listing, so the table previews
// the baked catalog merged with those files (later files win, like
// std::llm.loadModelData). A load failure aborts before printing so the user
// doesn't mistake a baked-only list for the merged one.
export async function modelsList(opts: ModelsListOpts, files: string[] = []): Promise<void> {
  for (const file of files) {
    const res = _loadModelData(file);
    if (!res.ok) {
      console.error(`Cannot load ${file}: ${res.error}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(formatHostedCatalog(selectHostedModels(_listHostedModels(), opts)));
}

export async function modelsRefresh(url?: string): Promise<void> {
  const res = await _fetchModelData(url ?? "");
  if (res.ok) {
    console.log(res.json); // stdout only — clean JSON for redirection
  } else {
    console.error(`Refresh failed: ${res.error}`);
    process.exitCode = 1;
  }
}
