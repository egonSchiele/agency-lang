export type FinalResponse = {
  text: string;
  truncated?: true;
  missing: boolean;
};

export function selectFinalResponse(record: any): FinalResponse {
  if (Array.isArray(record?.evalOutputs)) {
    const last = record.evalOutputs.at(-1);
    if (last === undefined) return { text: "", missing: true };
    return {
      text: stringify(last.value),
      truncated: last.truncated === true ? true : undefined,
      missing: false,
    };
  }

  if ("finalResponse" in (record ?? {})) {
    const value = record.finalResponse;
    return { text: value ?? "", missing: value === null };
  }

  return { text: "", missing: true };
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}
