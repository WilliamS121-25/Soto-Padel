import { cookies } from "next/headers";

/**
 * Who is using the app.
 *
 * There is no authentication: anyone who can reach the app can use it, and can
 * read and change everything in it. The name here is not a credential and is not
 * checked against anything — it exists only so the rating history and audit
 * trail can say who made a change. Anyone can set it to anything.
 *
 * Because it guards nothing, the cookie is stored plainly. It is deliberately
 * not signed: signing would imply a trust boundary that does not exist, and
 * would need a secret to be configured for no benefit.
 *
 * Restoring the passcode gate means reverting the commit that removed it; the
 * previous implementation is in the git history.
 */

const COOKIE = "soto_admin_name";
const MAX_AGE = 60 * 60 * 24 * 365;
const MAX_LENGTH = 40;

/** Shown when nobody has said who they are. */
export const DEFAULT_ADMIN_NAME = "Admin";

/** Trim to something sensible to store and display. */
export function cleanAdminName(input: string): string {
  const trimmed = input.trim().replace(/\s+/g, " ").slice(0, MAX_LENGTH);
  return trimmed === "" ? DEFAULT_ADMIN_NAME : trimmed;
}

/**
 * The current user's display name. Never redirects and never fails — with no
 * cookie set, everyone is simply the default admin.
 */
export async function adminName(): Promise<string> {
  const value = (await cookies()).get(COOKIE)?.value;
  if (!value) return DEFAULT_ADMIN_NAME;
  try {
    return cleanAdminName(decodeURIComponent(value));
  } catch {
    // A malformed cookie is not worth an error page.
    return DEFAULT_ADMIN_NAME;
  }
}

export async function setAdminName(name: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, encodeURIComponent(cleanAdminName(name)), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}
