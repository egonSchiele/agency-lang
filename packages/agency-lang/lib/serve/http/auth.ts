export function checkAuth(
  configuredKey: string | undefined,
  authHeader: string | undefined,
): boolean {
  if (!configuredKey) return true;
  if (!authHeader) return false;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;
  return parts[1] === configuredKey;
}
