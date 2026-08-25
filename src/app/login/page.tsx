import { redirect } from "next/navigation";
import { getAdmin, isConfigured } from "@/lib/auth";
import { loginAction } from "../actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getAdmin()) redirect("/");
  const { error } = await searchParams;
  const configured = isConfigured();

  return (
    <div className="login-wrap">
      <h1>Soto Padel</h1>
      <p className="lede">Mixin admin. Sign in with the group passcode.</p>

      {!configured && (
        <div className="note bad">
          <strong>Not set up yet.</strong> Copy <code>.env.example</code> to <code>.env</code> and
          set <code>ADMIN_PASSCODE</code> and <code>SESSION_SECRET</code>, then restart. Until then
          nobody can sign in.
        </div>
      )}

      {error && <div className="note bad">{error}</div>}

      <form action={loginAction} className="card">
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input id="name" name="name" required autoComplete="name" placeholder="e.g. William" />
          <p className="small muted" style={{ marginBottom: 0 }}>
            Used to record who changed what. Not a password.
          </p>
        </div>
        <div className="field">
          <label htmlFor="passcode">Group passcode</label>
          <input id="passcode" name="passcode" type="password" required autoComplete="current-password" />
        </div>
        <button type="submit" className="primary" disabled={!configured}>
          Sign in
        </button>
      </form>
    </div>
  );
}
