/**
 * AWS's `UriEncode`, the one place URL/path encoding for AWS requests lives.
 * Only the unreserved characters `A-Za-z0-9-._~` stay literal; every other byte
 * becomes uppercase `%XX`. A space is `%20`, never `+`. With `encodeSlash` false
 * the `/` separators in a path are left alone; with it true (query values), `/`
 * becomes `%2F`. Bytes are the UTF-8 encoding of `value`, encoded once.
 */
export function awsUriEncode(value: string, encodeSlash: boolean): string {
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const byte of bytes) {
    const isUnreserved =
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || // -
      byte === 0x2e || // .
      byte === 0x5f || // _
      byte === 0x7e; // ~
    if (isUnreserved) {
      out += String.fromCharCode(byte);
    } else if (byte === 0x2f && !encodeSlash) {
      out += "/";
    } else {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}
