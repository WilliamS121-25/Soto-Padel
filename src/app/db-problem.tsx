import type { DatabaseProblem } from "@/db";

/**
 * Shown in place of the app when the database cannot be opened.
 *
 * Deliberately a normal rendered page rather than a thrown error: Next replaces
 * error messages with a generic string in production, so an admin looking at a
 * crash page learns nothing. Everything here is worked out server-side and
 * rendered directly, so the reason survives.
 */
export function DatabaseProblemPage({ problem }: { problem: DatabaseProblem }) {
  return (
    <div className="card" style={{ maxWidth: 640, margin: "8vh auto" }}>
      <h1>The app cannot reach its database</h1>
      <p className="lede">{problem.summary}</p>

      <div className="note bad">
        <strong>What to do</strong>
        <div className="small">{problem.remedy}</div>
      </div>

      <table style={{ marginTop: 14 }}>
        <tbody>
          <tr>
            <th style={{ width: 110 }}>Error</th>
            <td>
              <code>{problem.code}</code>
            </td>
          </tr>
          <tr>
            <th>Database</th>
            <td>
              <code style={{ wordBreak: "break-all" }}>{problem.path}</code>
            </td>
          </tr>
          <tr>
            <th>Detail</th>
            <td className="small muted" style={{ wordBreak: "break-all" }}>
              {problem.detail}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
        This is a connection problem, not a data problem: nothing that was already
        saved has been touched. The app checks again on every request, so it starts
        working the moment the database is reachable — no restart needed.
      </p>
    </div>
  );
}
