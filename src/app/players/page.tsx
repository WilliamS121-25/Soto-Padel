import Link from "next/link";
import * as db from "@/db";
import { formatRating, ratingBand, ratingOptions } from "@/domain/rating";
import { createPlayerAction } from "../actions";

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { error, notice } = await searchParams;
  const players = await db.listPlayers(true);
  const history = await db.buildHistoryIndex();

  return (
    <>
      <h1>Players</h1>
      <p className="lede">
        Ratings drive the matching. Open a player to change their rating, see how it has moved, and
        see who they have played with and against.
      </p>

      {error && <div className="note bad">{error}</div>}
      {notice && <div className="note">{notice}</div>}

      <div className="card">
        <h2>{players.length} players</h2>
        {players.length === 0 ? (
          <p className="empty">No players yet. Add the first one below.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Rating</th>
                  <th>Level</th>
                  <th className="num">Games played</th>
                  <th>Last played</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {players.map((player) => (
                  <tr key={player.id}>
                    <td>
                      <Link href={`/players/${player.id}`}>{player.name}</Link>
                      {player.phone && <div className="small muted">{player.phone}</div>}
                    </td>
                    <td className="num">{formatRating(player.rating)}</td>
                    <td className="small muted">{ratingBand(player.rating)}</td>
                    <td className="num">{history.gamesPlayed(player.id)}</td>
                    <td className="small muted">{history.lastPlayedDate(player.id) ?? "—"}</td>
                    <td>
                      {!player.active && <span className="pill out">inactive</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Add a player</h2>
        <form action={createPlayerAction}>
          <div className="row">
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" required />
            </div>
            <div className="field">
              <label htmlFor="rating">Padel rating</label>
              <select id="rating" name="rating" defaultValue="3.5" required>
                {ratingOptions().map((value) => (
                  <option key={value} value={value}>
                    {formatRating(value)} — {ratingBand(value)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="phone">Phone (optional)</label>
              <input id="phone" name="phone" inputMode="tel" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="notes">Notes (optional)</label>
            <input id="notes" name="notes" placeholder="e.g. prefers the right side" />
          </div>
          <div className="actions">
            <button type="submit" className="primary">
              Add player
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
