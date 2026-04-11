export type ResultValue = ResultSuccess | ResultFailure;

export type ResultSuccess = {
  success: true;
  value: any;
};

export type ResultFailure = {
  success: false;
  error: any;
  checkpoint: any;
};

export function success(value: any): ResultSuccess {
  return { success: true, value };
}

export function failure(error: any): ResultFailure {
  return { success: false, error, checkpoint: null };
}

export function isSuccess(result: ResultValue): result is ResultSuccess {
  return result != null && result.success === true;
}

export function isFailure(result: ResultValue): result is ResultFailure {
  return result != null && result.success === false;
}

export async function __pipeBind(result: ResultValue, fn: (value: any) => any): Promise<ResultValue> {
  if (!result.success) return result;
  const output = await fn(result.value);
  if (output != null && typeof output === "object" && "success" in output && typeof output.success === "boolean") {
    return output;
  }
  return { success: true, value: output };
}
