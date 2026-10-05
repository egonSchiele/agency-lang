/** What every function in `agency-lang/local` that can fail returns: the
 *  value, or a message saying why there is none.
 *
 *  ```ts
 *  const tags = await tagImage({ model: "wd14-tagger", image: "page.png" });
 *  if (tags.success) {
 *    console.log(tags.value);
 *  } else {
 *    console.error(tags.error);
 *  }
 *  ```
 *
 *  It is a plain type of its own. The Agency runtime and smoltalk each
 *  have a result type with more in it, and neither is part of this entry
 *  point. */
export type Result<T> = { success: true; value: T } | { success: false; error: string };

export function success<T>(value: T): Result<T> {
  return { success: true, value };
}

export function failure<T = never>(error: string): Result<T> {
  return { success: false, error };
}
