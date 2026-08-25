import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { getAdmin } from "@/lib/auth";
import { signOutAction } from "./actions";
import { NavLinks } from "./nav";

export const metadata: Metadata = {
  title: "Soto Padel — Mixin Admin",
  description: "Run the weekly social padel mixin: places, reserves, line-ups and payment.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const admin = await getAdmin();

  return (
    <html lang="en">
      <body>
        {admin && (
          <header className="masthead">
            <div className="masthead-inner">
              <div className="brand">
                Soto <span>Padel</span>
              </div>
              <NavLinks />
              <div className="whoami">
                <span>{admin}</span>
                <form action={signOutAction}>
                  <button type="submit" className="link">
                    Sign out
                  </button>
                </form>
              </div>
            </div>
          </header>
        )}
        <main>{children}</main>
      </body>
    </html>
  );
}
