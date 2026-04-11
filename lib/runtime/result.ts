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
