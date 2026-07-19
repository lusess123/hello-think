import type { GitHubUser } from "./auth";

/**
 * Production access is fail-closed because every admitted user can ask the
 * GitHub App to write its installation repository. The comma-separated list
 * accepts only immutable numeric GitHub user IDs; logins can be renamed and
 * later reused by a different account.
 */
export function isStoryUserAllowed(
  user: GitHubUser,
  allowedUsers: string | undefined,
  devMode = false
): boolean {
  if (devMode) return true;
  const allowed = new Set(
    (allowedUsers ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
  return allowed.has(String(user.id));
}

export function storyDirectoryName(user: GitHubUser, devMode = false): string {
  // Preserve the familiar local DO name so existing local working copies and
  // audit events survive this security upgrade. Production always uses ID.
  return devMode ? user.login : `github-${user.id}`;
}
