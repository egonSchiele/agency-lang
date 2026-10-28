const HTTP_PROTOCOLS = ["http:", "https:"];

/** True when `value` parses as a URL and uses http or https. A prefix
 *  check would accept `"https://"` on its own. */
export function _isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  return HTTP_PROTOCOLS.includes(new URL(value).protocol);
}
