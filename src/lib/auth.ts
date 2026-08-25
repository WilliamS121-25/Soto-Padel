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

/** True when the supplied passcode matches the configured one. */
export function passcodeMatches(input: string): boolean {
  const expected = process.env.ADMIN_PASSCODE;
  // Fail closed: with no passcode configured, nobody gets in.
  if (!expected) return false;
  return safeEqual(input, expected);
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
