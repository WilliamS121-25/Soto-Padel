import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSignIn, isConfigured } from "@/lib/auth";

const original = { ...process.env };

beforeEach(() => {
  process.env.ADMIN_PASSCODE = "correct-horse";
  process.env.SESSION_SECRET = "a-long-random-signing-secret";
});

afterEach(() => {
  process.env = { ...original };
});

describe("what the sign-in form actually checks", () => {
  it("accepts any non-empty name — there is no username", () => {
    for (const name of ["William", "x", "Ana Lopez", "  padded  ", "12345"]) {
      expect(checkSignIn(name, "correct-horse")).toBeNull();
    }
  });

  it("rejects a name that is empty or only whitespace", () => {
    expect(checkSignIn("", "correct-horse")).toBe("MISSING_NAME");
    expect(checkSignIn("   ", "correct-horse")).toBe("MISSING_NAME");
  });

  it("matches the passcode exactly against ADMIN_PASSCODE", () => {
    expect(checkSignIn("William", "correct-horse")).toBeNull();
    expect(checkSignIn("William", "Correct-Horse")).toBe("WRONG_PASSCODE");
    expect(checkSignIn("William", "correct-horse ")).toBe("WRONG_PASSCODE");
    expect(checkSignIn("William", "correct")).toBe("WRONG_PASSCODE");
  });

  it("tells a blank passcode apart from a wrong one", () => {
    expect(checkSignIn("William", "")).toBe("MISSING_PASSCODE");
    expect(checkSignIn("William", "nope")).toBe("WRONG_PASSCODE");
  });
});

describe("blaming the server rather than the admin when the server is at fault", () => {
  it("says so when no passcode is configured, instead of 'wrong passcode'", () => {
    delete process.env.ADMIN_PASSCODE;
    expect(checkSignIn("William", "anything")).toBe("NOT_CONFIGURED");
    // Even an empty attempt gets the real cause, since none could ever succeed.
    expect(checkSignIn("William", "")).toBe("NOT_CONFIGURED");
  });

  it("catches a missing signing secret before it becomes a 500", () => {
    delete process.env.SESSION_SECRET;
    // The passcode here is correct: without this check the attempt would get
    // past the comparison and then throw while signing the cookie.
    expect(checkSignIn("William", "correct-horse")).toBe("NO_SESSION_SECRET");
  });

  it("still reports a blank name first, since that is the admin's to fix", () => {
    delete process.env.ADMIN_PASSCODE;
    expect(checkSignIn("", "anything")).toBe("MISSING_NAME");
  });
});

describe("not leaking anything about the passcode", () => {
  it("gives the same answer however wrong the guess is", () => {
    const guesses = ["", "c", "correct-hors", "correct-horsf", "CORRECT-HORSE", "x".repeat(200)];
    const answers = guesses.filter((g) => g !== "").map((g) => checkSignIn("William", g));
    expect(new Set(answers)).toEqual(new Set(["WRONG_PASSCODE"]));
  });

  it("reports configuration state without revealing the passcode", () => {
    expect(isConfigured()).toBe(true);
    delete process.env.ADMIN_PASSCODE;
    expect(isConfigured()).toBe(false);
  });
});
