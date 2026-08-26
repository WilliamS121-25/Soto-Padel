import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { databaseProblem } from "@/db";
import { adminName } from "@/lib/admin";
import { setNameAction } from "./actions";
import { DatabaseProblemPage } from "./db-problem";
import { NavLinks } from "./nav";

export const metadata: Metadata = {
  title: "Soto Padel — Mixin Admin",
  description: "Run the weekly social padel mixin: places, reserves, line-ups and payment.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const admin = await adminName();

  // Checked once here rather than in every page: if the database cannot be
  // opened, every route below would throw, and a bare crash page tells an admin
  // nothing about why.
  const problem = await databaseProblem();

  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <div className="masthead-inner">
            <div className="brand">
              Soto <span>Padel</span>
            </div>
            <NavLinks />

            {/*
              A display name, not a sign-in. It is recorded against changes so
              the rating history reads sensibly; it guards nothing.
            */}
            <details className="whoami">
              <summary title="Change the name recorded against your changes">{admin}</summary>
              <form action={setNameAction} className="whoami-form">
                <label htmlFor="admin-name">Recorded against your changes</label>
                <div className="whoami-row">
                  <input
                    id="admin-name"
                    name="name"
                    defaultValue={admin}
                    maxLength={40}
                    placeholder="e.g. William"
                  />
                  <button type="submit" className="primary">
                    Save
                  </button>
                </div>
              </form>
            </details>
          </div>
        </header>
        <main>{problem ? <DatabaseProblemPage problem={problem} /> : children}</main>
      </body>
    </html>
  );
}
