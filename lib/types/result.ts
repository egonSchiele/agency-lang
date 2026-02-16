export type Success<T> = {
  success: true;
  value: T;
};
export type Failure = {
  success: false;
  error: string;
};
export type Result<T> = Success<T> | Failure;

export function success<T>(value: T): Success<T> {
  return { success: true, value };
}

export function failure(error: string): Failure {
  return { success: false, error };
}

export function mergeResults<T>(results: Result<T>[]): Result<T[]> {
  const values: T[] = [];
  const failures: string[] = [];
  for (const result of results) {
    if (!result.success) {
      failures.push(result.error);
    } else {
      values.push(result.value);
    }
  }
  if (failures.length > 0) {
    return failure(failures.join(", "));
  }
  return success(values);
}

export function resultMap<T, U>(
  result: Result<T>,
  fn: (value: T) => U,
): Result<U> {
  if (result.success) {
    return success(fn(result.value));
  } else {
    return result;
  }
}
