import { redirect } from "next/navigation";
import { getAdmin, isConfigured, type SignInProblem } from "@/lib/auth";
import { loginAction } from "../actions";

/**
 * What the admin is told when a sign-in fails.
 *
 * `detail` explains what to do about it. Note that every wrong-passcode attempt
 * gets the same wording no matter what was typed: the app is guarded by one
 * shared passcode, so telling anyone how close they were, or how long it should
 * be, would just be a way to narrow it down.
 */
const PROBLEMS: Record<SignInProblem, { message: string; detail: string; fault: "user" | "setup" }> =
  {
    MISSING_NAME: {
      message: "Enter your name.",
      detail: "It is recorded against every change you make, so the history reads sensibly.",
      fault: "user",
    },
    MISSING_PASSCODE: {
      message: "Enter the group passcode.",
      detail: "It is the same passcode for every organiser.",
      fault: "user",
    },
    WRONG_PASSCODE: {
      message: "That passcode is not right.",
      detail: "There is one shared passcode for all organisers — check with whoever set the app up.",
      fault: "user",
    },
    NOT_CONFIGURED: {
      message: "This app has no passcode set, so nobody can sign in.",
      detail:
        "Whoever runs it needs to set ADMIN_PASSCODE in .env and restart. Until then every attempt fails, however it is typed.",
      fault: "setup",
    },
    NO_SESSION_SECRET: {
      message: "This app cannot keep you signed in.",
      detail:
        "SESSION_SECRET is not set, so the sign-in cookie cannot be signed. Whoever runs it needs to set it in .env and restart.",
      fault: "setup",
    },
  };

function isProblem(value: string | undefined): value is SignInProblem {
  return value !== undefined && value in PROBLEMS;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string }>;
}) {
  if (await getAdmin()) redirect("/");

  const { problem } = await searchParams;
  const failure = isProblem(problem) ? PROBLEMS[problem] : null;
  const configured = isConfigured();

  return (
    <div className="login-wrap">
      <h1>Soto Padel</h1>
      <p className="lede">Mixin admin. Sign in with the group passcode.</p>

      {/* Shown before anyone even tries, so a half-configured app says so up front. */}
      {!configured && !failure && (
        <div className="note bad">
          <strong>Not set up yet.</strong> Copy <code>.env.example</code> to <code>.env</code> and
          set <code>ADMIN_PASSCODE</code> and <code>SESSION_SECRET</code>, then restart. Until then
          nobody can sign in.
        </div>
      )}

      {failure && (
        <div className={failure.fault === "setup" ? "note bad" : "note warn"} role="alert">
          <strong>{failure.message}</strong>
          <div className="small">{failure.detail}</div>
        </div>
      )}

      <form action={loginAction} className="card">
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input
            id="name"
            name="name"
            required
            autoComplete="name"
            placeholder="e.g. William"
            aria-invalid={problem === "MISSING_NAME" || undefined}
          />
          <p className="small muted" style={{ marginBottom: 0 }}>
            Any name is accepted. It records who changed what — it is not a password.
          </p>
        </div>
        <div className="field">
          <label htmlFor="passcode">Group passcode</label>
          <input
            id="passcode"
            name="passcode"
            type="password"
            required
            autoComplete="current-password"
            aria-invalid={
              problem === "MISSING_PASSCODE" || problem === "WRONG_PASSCODE" || undefined
            }
          />
        </div>
        <button type="submit" className="primary" disabled={!configured}>
          Sign in
        </button>
      </form>
    </div>
  );
}
