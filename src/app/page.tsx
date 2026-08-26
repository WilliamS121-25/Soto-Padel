import Link from "next/link";
import * as db from "@/db";
import { allocateSignups } from "@/domain/signups";
import { formatDateLong, formatSlotCount, formatTime } from "@/domain/time";
import { computeCapacity } from "@/domain/timeline";
import { createSessionAction } from "./actions";
import { CourtPicker } from "./court-picker";

/** Next Friday, as a sensible default date for a weekly mixin. */
function nextFriday(): string {
  const today = new Date();
  const daysAhead = (5 - today.getUTCDay() + 7) % 7 || 7;
  const target = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + daysAhead));
  return target.toISOString().slice(0, 10);
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { error, notice } = await searchParams;
  const sessions = await db.listSessions();

  // Each row needs its signups, and JSX cannot await inside a map, so the rows
  // are assembled first. The queries are independent, so they run together
  // rather than one session at a time.
  const rows = await Promise.all(
    sessions.map(async (session) => {
      const allocation = allocateSignups(session, await db.listSignups(session.id));
      return {
        session,
        allocation,
        capacity: computeCapacity(session, allocation.committedPlayerBlocks),
      };
    }),
  );

  return (
    <>
      <h1>Mixins</h1>
      <p className="lede">Set up a mixin, take signups from the group, then draw the line-ups.</p>

      {error && <div className="note bad">{error}</div>}
      {notice && <div className="note">{notice}</div>}

      <div className="card">
        <h2>Upcoming and past mixins</h2>
        {sessions.length === 0 ? (
          <p className="empty">No mixins yet. Create the first one below.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Mixin</th>
                  <th>Courts</th>
                  <th className="num">Places</th>
                  <th className="num">Signed up</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ session, allocation, capacity }) => {
                  return (
                    <tr key={session.id}>
                      <td>
                        <Link href={`/sessions/${session.id}`}>{formatDateLong(session.date)}</Link>
                        <div className="small muted">
                          from {formatTime(session.startMinutes)} · {formatSlotCount(session.slotCount)}
                        </div>
                      </td>
                      <td>{session.name}</td>
                      <td className="small">
                        {session.courts.map((c) => c.courtNumber).join(", ") || "—"}
                      </td>
                      <td className="num">
                        {capacity.committedPlayerBlocks}/{capacity.totalPlayerBlocks}
                      </td>
                      <td className="num">
                        {allocation.confirmed.length}
                        {allocation.reserves.length > 0 && (
                          <span className="muted small"> +{allocation.reserves.length}</span>
                        )}
                      </td>
                      <td>
                        <span className={`pill ${session.status === "OPEN" ? "ok" : "plain"}`}>
                          {session.status.toLowerCase()}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>New mixin</h2>
        <form action={createSessionAction}>
          <div className="row">
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" defaultValue="Friday Social Mixin" />
            </div>
            <div className="field">
              <label htmlFor="date">Date</label>
              <input id="date" name="date" type="date" defaultValue={nextFriday()} required />
            </div>
            <div className="field">
              <label htmlFor="startTime">Start time</label>
              <input id="startTime" name="startTime" type="time" step={1800} defaultValue="18:00" required />
            </div>
            <div className="field">
              <label htmlFor="slotCount">Half-hours</label>
              <input id="slotCount" name="slotCount" type="number" min={1} max={16} defaultValue={4} required />
            </div>
          </div>

          <h3 style={{ marginTop: 8 }}>Courts</h3>
          <p className="small muted">
            Tick the courts you have booked. Each one can start at a different time from the mixin.
          </p>
          <CourtPicker defaultStart="18:00" defaultSlots={4} />

          <div className="row" style={{ marginTop: 14 }}>
            <div className="field">
              <label htmlFor="costPerCourtSlot">Court cost per 30 min</label>
              <input id="costPerCourtSlot" name="costPerCourtSlot" placeholder="6.00" inputMode="decimal" />
            </div>
            <div className="field">
              <label htmlFor="currency">Currency</label>
              <select id="currency" name="currency" defaultValue="EUR">
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="USD">USD</option>
              </select>
            </div>
          </div>

          <div className="actions">
            <button type="submit" className="primary">
              Create mixin
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
