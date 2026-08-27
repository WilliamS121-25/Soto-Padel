import Link from "next/link";
import { notFound } from "next/navigation";
import * as db from "@/db";
import { formatRating, ratingBand, ratingOptions } from "@/domain/rating";
import { deletePlayerAction, setRatingAction, updatePlayerAction } from "../../actions";

export default async function PlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { id } = await params;
  const { error, notice } = await searchParams;

  const player = await db.getPlayer(id);
  if (!player) notFound();

  const ratingHistory = await db.listRatingHistory(id);
  const history = await db.buildHistoryIndex();
  const names = new Map((await db.listPlayers(true)).map((p) => [p.id, p.name]));
  const nameOf = (playerId: string) => names.get(playerId) ?? "Unknown";

  const partners = history.partnersOf(id);
  const opponents = history.opponentsOf(id);
  // The same condition the delete itself enforces: a player who appears in a
  // saved draw cannot be removed without invalidating that draw.
  const hasPlayed = history.gamesPlayed(id) > 0;

  return (
    <>
      <p className="small muted">
        <Link href="/players">← All players</Link>
      </p>
      <h1>{player.name}</h1>
      <p className="lede">
        {formatRating(player.rating)} · {ratingBand(player.rating)} ·{" "}
        {history.gamesPlayed(id)} games played
        {player.active ? "" : " · inactive"}
      </p>

      {error && <div className="note bad">{error}</div>}
      {notice && <div className="note">{notice}</div>}

      <div className="grid two">
        <div className="card">
          <h2>Change rating</h2>
          <form action={setRatingAction}>
            <input type="hidden" name="playerId" value={player.id} />
            <div className="field">
              <label htmlFor="rating">New rating</label>
              <select id="rating" name="rating" defaultValue={String(player.rating)}>
                {ratingOptions().map((value) => (
                  <option key={value} value={value}>
                    {formatRating(value)} — {ratingBand(value)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="reason">Reason</label>
              <input id="reason" name="reason" placeholder="e.g. moved up after winning the Americano" />
            </div>
            <div className="actions">
              <button type="submit" className="primary">
                Save rating
              </button>
            </div>
          </form>
        </div>

        <div className="card">
          <h2>Details</h2>
          <form action={updatePlayerAction}>
            <input type="hidden" name="playerId" value={player.id} />
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" defaultValue={player.name} required />
            </div>
            <div className="field">
              <label htmlFor="phone">Phone</label>
              <input id="phone" name="phone" defaultValue={player.phone ?? ""} inputMode="tel" />
            </div>
            <div className="field">
              <label htmlFor="notes">Notes</label>
              <input id="notes" name="notes" defaultValue={player.notes ?? ""} />
            </div>
            <label className="check" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" name="active" defaultChecked={player.active} style={{ width: "auto" }} />
              Active — include in mixins
            </label>
            <div className="actions">
              <button type="submit">Save details</button>
            </div>
          </form>
        </div>
      </div>

      <div className="card">
        <h2>Rating history</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th className="num">From</th>
                <th className="num">To</th>
                <th>Reason</th>
                <th>Changed by</th>
              </tr>
            </thead>
            <tbody>
              {ratingHistory.map((change) => (
                <tr key={change.id}>
                  <td className="small">{change.changedAt.slice(0, 10)}</td>
                  <td className="num">
                    {change.previousRating === null ? "—" : formatRating(change.previousRating)}
                  </td>
                  <td className="num">{formatRating(change.newRating)}</td>
                  <td className="small">{change.reason ?? "—"}</td>
                  <td className="small muted">{change.changedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <h2>Played with</h2>
          {partners.length === 0 ? (
            <p className="empty">No games recorded yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Partner</th>
                  <th className="num">Times</th>
                </tr>
              </thead>
              <tbody>
                {partners.map((entry) => (
                  <tr key={entry.playerId}>
                    <td>
                      <Link href={`/players/${entry.playerId}`}>{nameOf(entry.playerId)}</Link>
                    </td>
                    <td className="num">{entry.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Played against</h2>
          {opponents.length === 0 ? (
            <p className="empty">No games recorded yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Opponent</th>
                  <th className="num">Times</th>
                </tr>
              </thead>
              <tbody>
                {opponents.map((entry) => (
                  <tr key={entry.playerId}>
                    <td>
                      <Link href={`/players/${entry.playerId}`}>{nameOf(entry.playerId)}</Link>
                    </td>
                    <td className="num">{entry.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Remove player</h2>
        {hasPlayed ? (
          <>
            <p className="small muted">
              {player.name} appears in the line-ups of {history.gamesPlayed(id)} recorded{" "}
              {history.gamesPlayed(id) === 1 ? "game" : "games"}, so they cannot be deleted —
              removing them would invalidate those draws and the payment schedules that follow from
              them.
            </p>
            <p className="small muted">
              Untick <strong>Active</strong> under Details instead. That keeps the record and leaves
              them out of future mixins.
            </p>
          </>
        ) : (
          <>
            <p className="small muted">
              Deletes {player.name} for good, along with their rating history and any signup they
              hold for a mixin that has not been drawn yet. Not reversible.
            </p>
            <form action={deletePlayerAction} className="actions">
              <input type="hidden" name="playerId" value={player.id} />
              <button type="submit" className="danger">
                Delete {player.name}
              </button>
            </form>
          </>
        )}
      </div>
    </>
  );
}
