/**
 * The rule for an agent's statelog name (`std::statelog` `setAgentName`).
 * The name becomes one path segment of a statelog URL
 * (`/evals/agents/<name>/batches/<batch>`), so it has to survive that trip
 * unchanged: no whitespace, no characters a URL would encode, and no `.` or
 * `..` segment, which a URL parser folds away (`agents/../batches` loses the
 * `agents` segment even after `encodeURIComponent`). Slashes are allowed so a
 * family can nest its variants, as in `agency-agent/coordinator`.
 */
export const AGENT_NAME_MAX_LENGTH = 200;

/** Letters, digits, `.`, `_`, `-`, and `/` between segments. */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

/** Why `name` is not a valid agent name, or null when it is. */
export function agentNameProblem(name: string): string | null {
  if (name === "") {
    return "an agent name must not be empty";
  }
  if (name.length > AGENT_NAME_MAX_LENGTH) {
    return `an agent name is at most ${AGENT_NAME_MAX_LENGTH} characters`;
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    return (
      `an agent name uses only letters, digits, ".", "_", "-" and "/" ` +
      `(got ${JSON.stringify(name)})`
    );
  }
  for (const segment of name.split("/")) {
    if (segment === "") {
      return `an agent name has no empty "/" segment (got ${JSON.stringify(name)})`;
    }
    if (segment === "." || segment === "..") {
      return `an agent name has no "." or ".." segment (got ${JSON.stringify(name)})`;
    }
  }
  return null;
}
