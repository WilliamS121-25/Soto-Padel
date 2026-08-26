import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Admin access is a single shared passcode plus the admin's own name.
 *
 * That is a deliberate choice for a club app shared between a handful of
 * organisers: there are no accounts to provision and the group can be given
 * access by passing on one passcode. The name is not authentication — it only
 * labels who made a change, so rating history reads sensibly. Anyone with the
 * passcode can type any name.
 */

const COOKIE = "soto_admin";
const MAX_AGE = 60 * 60 * 24 * 30;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) {
    throw new Error(
      "SESSION_SECRET is not set. Copy .env.example to .env and set it before starting the app.",
    );
  }
  return value;
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Why a sign-in attempt failed.
 *
 * The distinctions here are between *causes an admin can act on*: a field they
 * left blank, or a server that was never configured. What deliberately has no
 * variants is `WRONG_PASSCODE` — nothing reports how close the attempt was, how
 * long the passcode should be, or which characters matched. One shared passcode
 * guards the whole app, so any such hint would turn this form into a way to
 * narrow it down a guess at a time.
 */
export type SignInProblem =
  | "MISSING_NAME"
  | "MISSING_PASSCODE"
  | "NOT_CONFIGURED"
  | "NO_SESSION_SECRET"
  | "WRONG_PASSCODE";

/**
 * Check a sign-in attempt, returning why it failed or null if it is good.
 *
 * Server misconfiguration is checked before the passcode so that an app with no
 * `ADMIN_PASSCODE` set says exactly that, rather than telling an admin their
 * passcode is wrong when in truth no passcode could ever work.
 */
export function checkSignIn(name: string, passcode: string): SignInProblem | null {
  if (!name.trim()) return "MISSING_NAME";

  const expected = process.env.ADMIN_PASSCODE;
  // Fail closed: with no passcode configured, nobody gets in.
  if (!expected) return "NOT_CONFIGURED";

  // Checked here rather than at signing time, where a missing secret throws and
  // would surface as a 500 *after* the admin typed the right passcode.
  if (!process.env.SESSION_SECRET) return "NO_SESSION_SECRET";

  if (!passcode) return "MISSING_PASSCODE";
  if (!safeEqual(passcode, expected)) return "WRONG_PASSCODE";
  return null;
}

export function isConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSCODE && process.env.SESSION_SECRET);
}

export async function signIn(name: string): Promise<void> {
  const trimmed = name.trim().slice(0, 40);
  const store = await cookies();
  store.set(COOKIE, `${encodeURIComponent(trimmed)}.${sign(trimmed)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** The signed-in admin's name, or null. */
export async function getAdmin(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;

  const split = token.lastIndexOf(".");
  if (split <= 0) return null;

  const name = decodeURIComponent(token.slice(0, split));
  if (!safeEqual(token.slice(split + 1), sign(name))) return null;
  return name;
}

/** Use at the top of every page and action that changes anything. */
export async function requireAdmin(): Promise<string> {
  const admin = await getAdmin();
  if (!admin) redirect("/login");
  return admin;
}
