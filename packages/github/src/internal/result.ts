import type { ResultSuccess, ResultFailure } from "agency-lang/runtime";

// Local generic Result<T> alias. The runtime exports ResultSuccess/ResultFailure
// (with `value: any`), but no generic Result<T>. We narrow `value` to T here so
// the rest of the package can be properly typed.
export type Result<T> = (Omit<ResultSuccess, "value"> & { value: T }) | ResultFailure;
