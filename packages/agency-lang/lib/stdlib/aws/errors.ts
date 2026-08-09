import { failure, type ResultFailure } from "../../runtime/result.js";
import { normalizeSnippet } from "../http.js";

/**
 * S3 reports errors as a small fixed XML document
 * (`<Error><Code>…</Code><Message>…</Message></Error>`). We extract the two
 * fields we care about with a narrow tag scan — no XML-parser dependency.
 */
export type S3ErrorFields = { code: string; message: string };

function tagText(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : "";
}

/** Best-effort: returns empty fields when the body is not the expected XML. */
export function parseS3Error(xmlBody: string): S3ErrorFields {
  return { code: tagText(xmlBody, "Code"), message: tagText(xmlBody, "Message") };
}

/** Turn a non-2xx S3 response into a coded `failure`. */
export function s3ErrorToFailure(
  status: number,
  statusText: string,
  url: string,
  body: string,
): ResultFailure {
  const { code, message } = parseS3Error(body);
  const label = code || normalizeSnippet(body) || statusText || "error";
  return failure({
    status,
    statusText,
    url,
    code,
    s3Message: message,
    body: normalizeSnippet(body),
    message: `S3 ${status} for ${url}: ${label}`,
  });
}
