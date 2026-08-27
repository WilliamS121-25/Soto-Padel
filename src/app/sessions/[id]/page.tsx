import Link from "next/link";
import { notFound } from "next/navigation";
import * as db from "@/db";
import { blocksPlayedFromMatches, buildPaymentSchedule, formatMoney } from "@/domain/payments";
import { formatRating, ratingOptions } from "@/domain/rating";
import { MAX_GAMES_PER_BLOCK } from "@/domain/types";
import { detectScheduleDrift, reconstructRounds, summariseRepeats } from "@/domain/scheduler";
import {
  hasScore,
  materialRatingChanges,
  ratingChangesFromResults,
} from "@/domain/rating-updates";
import { allocateSignups } from "@/domain/signups";
import { formatDateLong, formatSlotCount, formatSlotRange, formatTime } from "@/domain/time";
import { computeCapacity } from "@/domain/timeline";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "@/domain/types";
import {
  availabilityMessage,
  currencySymbol,
  paymentMessage,
  scheduleMessage,
  signupOpenMessage,
} from "@/domain/whatsapp";
import {
  addSignupAction,
  applyRatingsAction,
  clearScheduleAction,
  deleteSessionAction,
  generateScheduleAction,
  importSignupsAction,
  removeSignupAction,
  restoreSignupAction,
  setScoreAction,
  updateSessionAction,
  updateSignupAction,
  withdrawSignupAction,
} from "../../actions";
import { CopyButton } from "../../copy-button";
import { CourtPicker } from "../../court-picker";

export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { id } = await params;
  const { error, notice } = await searchParams;

  const session = await db.getSession(id);
  if (!session) notFound();

  const players = await db.listPlayers(true);
  const byId = new Map(players.map((p) => [p.id, p]));
  const nameOf = (playerId: string) => byId.get(playerId)?.name ?? "Unknown";
  const ratingOf = (playerId: string) => byId.get(playerId)?.rating ?? 0;

  const signups = await db.listSignups(id);
  const allocation = allocateSignups(session, signups);
  const capacity = computeCapacity(session, allocation.committedPlayerBlocks);

  const matches = await db.listMatches(id);
  const rounds = reconstructRounds(session, allocation.confirmed, matches);
  const drift = detectScheduleDrift(allocation.confirmed, matches);
  const repeats = summariseRepeats(matches);

  const scoredMatches = matches.filter((match) =>
    hasScore({ gamesA: match.scoreA ?? 0, gamesB: match.scoreB ?? 0 }),
  );
  const ratingPreview = materialRatingChanges(
    ratingChangesFromResults(
      scoredMatches.map((match) => ({
        teamA: match.teamA,
        teamB: match.teamB,
        gamesA: match.scoreA ?? 0,
        gamesB: match.scoreB ?? 0,
      })),
      new Map(players.map((player) => [player.id, player.rating])),
    ),
  );
  const blocksPlayed = blocksPlayedFromMatches(matches);
  const payments = buildPaymentSchedule(session, allocation.confirmed, blocksPlayed);
  const symbol = currencySymbol(session.currency);

  const signedUpIds = new Set(signups.map((s) => s.playerId));
  const availablePlayers = players.filter((p) => !signedUpIds.has(p.id));
  const signupById = new Map(signups.map((s) => [s.id, s]));

  return (
    <>
      <p className="small muted">
        <Link href="/">← All mixins</Link>
      </p>
      <h1>{session.name}</h1>
      <p className="lede">
        {formatDateLong(session.date)} · from {formatTime(session.startMinutes)} ·{" "}
        {session.courts.length} court{session.courts.length === 1 ? "" : "s"} ·{" "}
        <span className="pill plain">{session.status.toLowerCase()}</span>
      </p>

      {error && <div className="note bad">{error}</div>}
      {notice && <div className="note">{notice}</div>}

      <div className="card">
        <div className="stats">
          <div>
            <div className="stat-label">Places</div>
            <div className="stat-value">
              {capacity.committedPlayerBlocks}/{capacity.totalPlayerBlocks}
            </div>
            <div className="small muted">30-min game slots</div>
          </div>
          <div>
            <div className="stat-label">Still free</div>
            <div className="stat-value">{capacity.remainingPlayerBlocks}</div>
            <div className="small muted">game slots</div>
          </div>
          <div>
            <div className="stat-label">Confirmed</div>
            <div className="stat-value">{allocation.confirmed.length}</div>
            <div className="small muted">players</div>
          </div>
          <div>
            <div className="stat-label">Reserves</div>
            <div className="stat-value">{allocation.reserves.length}</div>
            <div className="small muted">waiting</div>
          </div>
          <div>
            <div className="stat-label">Per person</div>
            <div className="stat-value">
              {symbol}
              {formatMoney(session.costPerPlayer)}
            </div>
            <div className="small muted">{capacity.totalCourtBlocks} court-blocks booked</div>
          </div>
        </div>

        <div className="table-scroll" style={{ marginTop: 16 }}>
          <table>
            <thead>
              <tr>
                <th>Court</th>
                <th>Running</th>
                <th className="num">Half-hours</th>
                <th className="num">Seats offered</th>
              </tr>
            </thead>
            <tbody>
              {session.courts.map((court) => (
                <tr key={court.courtNumber}>
                  <td>Court {court.courtNumber}</td>
                  <td>{formatSlotRange(court.startMinutes, court.slotCount)}</td>
                  <td className="num">{formatSlotCount(court.slotCount)}</td>
                  <td className="num">{court.slotCount * 4}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {allocation.issues.length > 0 && (
        <div className="note warn">
          <strong>Worth checking:</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            {allocation.issues.map((issue) => (
              <li key={issue.signupId} className="small">
                {nameOf(issue.playerId)}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---------------------------------------------------------- signups -- */}
      <div className="card">
        <h2>Signups</h2>

        {allocation.confirmed.length === 0 && allocation.reserves.length === 0 ? (
          <p className="empty">Nobody signed up yet. Add people below.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th className="num">Rating</th>
                  <th className="num">Games</th>
                  <th>From</th>
                  <th>Status</th>
                  <th>Paying by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[
                  ...allocation.confirmed.map((s) => ({ signup: s, kind: "CONFIRMED" as const })),
                  ...allocation.reserves.map((s) => ({ signup: s, kind: "RESERVE" as const })),
                  ...allocation.withdrawn.map((s) => ({ signup: s, kind: "WITHDRAWN" as const })),
                ].map(({ signup, kind }, index) => {
                  const stored = signupById.get(signup.id);
                  return (
                    <tr key={signup.id}>
                      <td className="small muted">{index + 1}</td>
                      <td>
                        <Link href={`/players/${signup.playerId}`}>{nameOf(signup.playerId)}</Link>
                        {stored && stored.requestedSlots !== signup.requestedSlots && (
                          <div className="small muted">asked for {stored.requestedSlots}</div>
                        )}
                      </td>
                      <td className="num">{formatRating(ratingOf(signup.playerId))}</td>
                      <td className="num">
                        <form action={updateSignupAction} style={{ display: "flex", gap: 4 }}>
                          <input type="hidden" name="sessionId" value={session.id} />
                          <input type="hidden" name="signupId" value={signup.id} />
                          <input
                            type="number"
                            name="requestedSlots"
                            min={1}
                            max={16}
                            defaultValue={stored?.requestedSlots ?? signup.requestedSlots}
                            style={{ width: 60 }}
                            aria-label={`Games for ${nameOf(signup.playerId)}`}
                          />
                          <button type="submit" className="link">
                            save
                          </button>
                        </form>
                      </td>
                      <td>{formatTime(signup.earliestStartMinutes)}</td>
                      <td>
                        <span
                          className={`pill ${kind === "CONFIRMED" ? "ok" : kind === "RESERVE" ? "wait" : "out"}`}
                        >
                          {kind === "CONFIRMED" ? "in" : kind === "RESERVE" ? "reserve" : "out"}
                        </span>
                      </td>
                      <td>
                        <form action={updateSignupAction}>
                          <input type="hidden" name="sessionId" value={session.id} />
                          <input type="hidden" name="signupId" value={signup.id} />
                          <select
                            name="paymentMethod"
                            defaultValue={stored?.paymentMethod ?? ""}
                            aria-label={`Payment method for ${nameOf(signup.playerId)}`}
                            style={{ minWidth: 110 }}
                          >
                            <option value="">not chosen</option>
                            {PAYMENT_METHODS.map((method) => (
                              <option key={method} value={method}>
                                {PAYMENT_METHOD_LABELS[method]}
                              </option>
                            ))}
                          </select>
                          <button type="submit" className="link">
                            save
                          </button>
                        </form>
                      </td>
                      <td>
                        {kind === "WITHDRAWN" ? (
                          <form action={restoreSignupAction}>
                            <input type="hidden" name="sessionId" value={session.id} />
                            <input type="hidden" name="signupId" value={signup.id} />
                            <button type="submit" className="link">
                              put back
                            </button>
                          </form>
                        ) : (
                          <form action={withdrawSignupAction}>
                            <input type="hidden" name="sessionId" value={session.id} />
                            <input type="hidden" name="signupId" value={signup.id} />
                            <button type="submit" className="link">
                              can&apos;t attend
                            </button>
                          </form>
                        )}
                        <form action={removeSignupAction}>
                          <input type="hidden" name="sessionId" value={session.id} />
                          <input type="hidden" name="signupId" value={signup.id} />
                          <button type="submit" className="link danger">
                            remove
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid two" style={{ marginTop: 18 }}>
          <div>
            <h3>Add one person</h3>
            <form action={addSignupAction}>
              <input type="hidden" name="sessionId" value={session.id} />
              <div className="field">
                <label htmlFor="playerId">Existing player</label>
                <select id="playerId" name="playerId" defaultValue="">
                  <option value="">— new person, type below —</option>
                  {availablePlayers.map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.name} ({formatRating(player.rating)})
                    </option>
                  ))}
                </select>
              </div>
              <div className="row">
                <div className="field">
                  <label htmlFor="newPlayerName">Or a new name</label>
                  <input id="newPlayerName" name="newPlayerName" placeholder="e.g. Ana Lopez" />
                </div>
                <div className="field">
                  <label htmlFor="newPlayerRating">Their rating</label>
                  <select id="newPlayerRating" name="newPlayerRating" defaultValue="3.5">
                    {ratingOptions().map((value) => (
                      <option key={value} value={value}>
                        {formatRating(value)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="row">
                <div className="field">
                  <label htmlFor="requestedSlots">30-min games</label>
                  <input
                    id="requestedSlots"
                    name="requestedSlots"
                    type="number"
                    min={1}
                    max={16}
                    defaultValue={Math.min(2, session.slotCount)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="earliestStart">Can start at</label>
                  <input
                    id="earliestStart"
                    name="earliestStart"
                    type="time"
                    step={1800}
                    defaultValue={formatTime(session.startMinutes)}
                  />
                </div>
              </div>
              <div className="actions">
                <button type="submit" className="primary">
                  Add signup
                </button>
              </div>
            </form>
          </div>

          <div>
            <h3>Paste from WhatsApp</h3>
            <p className="small muted">
              Paste the replies from the group. One person per line, for example{" "}
              <code>Ana — 3 — 18:30</code>. Raw WhatsApp exports work too. Anything it cannot read
              is reported back rather than guessed.
            </p>
            <form action={importSignupsAction}>
              <input type="hidden" name="sessionId" value={session.id} />
              <div className="field">
                <label htmlFor="text">Pasted messages</label>
                <textarea id="text" name="text" placeholder={"Ana — 3 — 18:00\nLuis - 2 - 19:00"} />
              </div>
              <div className="row">
                <div className="field">
                  <label htmlFor="defaultGames">Games if not stated</label>
                  <input
                    id="defaultGames"
                    name="defaultGames"
                    type="number"
                    min={1}
                    max={16}
                    defaultValue={Math.min(2, session.slotCount)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="defaultRating">Rating for new players</label>
                  <select id="defaultRating" name="defaultRating" defaultValue="3.5">
                    {ratingOptions().map((value) => (
                      <option key={value} value={value}>
                        {formatRating(value)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="actions">
                <button type="submit">Import signups</button>
              </div>
            </form>
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- line-ups -- */}
      <div className="card">
        <h2>Line-ups</h2>
        <p className="small muted">
          Nobody partners or faces the same player twice in a mixin, the two teams in a four add up
          to a similar total, and levels are deliberately mixed so lower-rated players get games
          with and against stronger ones. Earlier mixins are taken into account too. Re-draw gives a
          different valid set.
        </p>

        {drift.isStale && (
          <div className="note warn">
            <strong>These line-ups are out of date.</strong>
            {drift.scheduledButNotAttending.length > 0 && (
              <div className="small">
                In the draw but no longer attending:{" "}
                {drift.scheduledButNotAttending.map(nameOf).join(", ")}.
              </div>
            )}
            {drift.confirmedButNotScheduled.length > 0 && (
              <div className="small">
                Confirmed but not in the draw:{" "}
                {drift.confirmedButNotScheduled.map(nameOf).join(", ")}.
              </div>
            )}
            <div className="small">
              Generate again before sending the line-ups or the payment schedule.
            </div>
          </div>
        )}

        {matches.length > 0 &&
          (repeats.partnerships.length > 0 || repeats.opponents.length > 0 ? (
            <div className="note warn small">
              <strong>Some repeats could not be avoided.</strong> There are not enough different
              players for the number of games, so the draw took the smallest compromise it could.
              {repeats.partnerships.length > 0 && (
                <div>
                  Partnered twice:{" "}
                  {repeats.partnerships
                    .map((r) => `${nameOf(r.playerIds[0])} & ${nameOf(r.playerIds[1])}`)
                    .join(", ")}
                  .
                </div>
              )}
              {repeats.opponents.length > 0 && (
                <div>
                  Faced each other more than once:{" "}
                  {repeats.opponents
                    .map(
                      (r) =>
                        `${nameOf(r.playerIds[0])} v ${nameOf(r.playerIds[1])} (${r.times}x)`,
                    )
                    .join(", ")}
                  .
                </div>
              )}
            </div>
          ) : (
            <p className="small muted">
              ✓ No repeated partnerships or opponents in this draw.
            </p>
          ))}

        <div className="actions" style={{ marginBottom: 14 }}>
          <form action={generateScheduleAction}>
            <input type="hidden" name="sessionId" value={session.id} />
            <button type="submit" className="primary">
              {matches.length > 0 ? "Generate again" : "Generate line-ups"}
            </button>
          </form>
          {matches.length > 0 && (
            <>
              <form action={generateScheduleAction}>
                <input type="hidden" name="sessionId" value={session.id} />
                <input type="hidden" name="reroll" value="1" />
                <button type="submit">Re-draw differently</button>
              </form>
              <form action={clearScheduleAction}>
                <input type="hidden" name="sessionId" value={session.id} />
                <button type="submit" className="danger">
                  Clear
                </button>
              </form>
            </>
          )}
        </div>

        {rounds.length === 0 ? (
          <p className="empty">
            No line-ups yet. Confirm at least four players, then generate.
          </p>
        ) : (
          rounds.map((round) => (
            <div key={round.slotIndex} className="round">
              <div className="round-head">
                <span>{formatSlotRange(round.startMinutes)}</span>
                {round.sittingOut.length > 0 && (
                  <span className="muted">
                    waiting: {round.sittingOut.map(nameOf).join(", ")}
                  </span>
                )}
              </div>
              <div className="round-body">
                {round.matches.map((match) => (
                  <div key={`${match.slotIndex}-${match.courtNumber}`} className="match">
                    <span className="court">Court {match.courtNumber}</span>
                    <span className="side">{match.teamA.map(nameOf).join(" & ")}</span>
                    <span className="vs">vs</span>
                    <span className="side">{match.teamB.map(nameOf).join(" & ")}</span>
                    <form action={setScoreAction} className="scorebox">
                      <input type="hidden" name="sessionId" value={session.id} />
                      <input type="hidden" name="slotIndex" value={match.slotIndex} />
                      <input type="hidden" name="courtNumber" value={match.courtNumber} />
                      <input
                        type="number"
                        name="scoreA"
                        min={0}
                        max={MAX_GAMES_PER_BLOCK}
                        defaultValue={match.scoreA ?? ""}
                        aria-label={`Games won by ${match.teamA.map(nameOf).join(" and ")}`}
                        placeholder="-"
                      />
                      <span className="dash">-</span>
                      <input
                        type="number"
                        name="scoreB"
                        min={0}
                        max={MAX_GAMES_PER_BLOCK}
                        defaultValue={match.scoreB ?? ""}
                        aria-label={`Games won by ${match.teamB.map(nameOf).join(" and ")}`}
                        placeholder="-"
                      />
                      <button type="submit" className="link">
                        save
                      </button>
                    </form>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* ---------------------------------------------------------- ratings -- */}
      {matches.length > 0 && (
        <div className="card">
          <h2>Ratings from the results</h2>
          {session.ratingsAppliedAt ? (
            <div className="note">
              Ratings were updated from this mixin on{" "}
              {session.ratingsAppliedAt.slice(0, 10)}. Each change is on the player&apos;s page
              with the reason. This runs once per mixin, so the same games cannot be counted
              twice — correct a mistake by editing that player&apos;s rating directly.
            </div>
          ) : (
            <>
              <p className="small muted">
                Enter the games each team won next to the line-ups above. Ratings move on the
                margin, not just the win: beating a stronger pair moves you more, and a result
                that lands where the ratings predicted barely moves anyone. Nothing changes until
                you apply it.
              </p>

              {scoredMatches.length === 0 ? (
                <p className="empty">No scores recorded yet.</p>
              ) : (
                <>
                  <p className="small muted">
                    {scoredMatches.length} of {matches.length} games scored
                    {scoredMatches.length < matches.length && " — unscored games are ignored"}.
                  </p>

                  {ratingPreview.length === 0 ? (
                    <p className="empty">
                      These results imply no rating change — everyone played to their level.
                    </p>
                  ) : (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Player</th>
                            <th className="num">Games</th>
                            <th className="num">Rating</th>
                            <th className="num">Change</th>
                            <th className="num">New rating</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ratingPreview.map((change) => (
                            <tr key={change.playerId}>
                              <td>{nameOf(change.playerId)}</td>
                              <td className="num">{change.gamesCounted}</td>
                              <td className="num">{formatRating(change.from)}</td>
                              <td className="num">
                                <span className={`pill ${change.delta > 0 ? "ok" : "out"}`}>
                                  {change.delta > 0 ? "+" : ""}
                                  {change.delta.toFixed(2)}
                                </span>
                              </td>
                              <td className="num">{formatRating(change.to)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {ratingPreview.length > 0 && (
                    <form action={applyRatingsAction} className="actions">
                      <input type="hidden" name="sessionId" value={session.id} />
                      <button type="submit" className="primary">
                        Apply these rating changes
                      </button>
                    </form>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* --------------------------------------------------------- payments -- */}
      <div className="card">
        <h2>Payment</h2>
        {payments.lines.length === 0 ? (
          <p className="empty">
            Generate the line-ups first — only the players who end up on court are charged.
          </p>
        ) : (
          <>
            {drift.isStale && (
              <div className="note warn small">
                Based on line-ups that are out of date — generate them again before sending this
                out.
              </div>
            )}
            {payments.costPerPlayer === 0 ? (
              <div className="note warn small">
                No cost per person has been set for this mixin, so everybody owes nothing. Set it in
                Mixin setup below.
              </div>
            ) : null}
            <p className="small muted">
              {symbol}
              {formatMoney(payments.costPerPlayer)} each, from the {payments.payingPlayers}{" "}
              {payments.payingPlayers === 1 ? "player who is" : "players who are"} on court. Games
              played do not change what someone owes. Set each person&apos;s payment method in the
              signups table above.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Player</th>
                    <th className="num">Games</th>
                    <th className="num">Owes</th>
                    <th>Paying by</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.lines.map((line) => (
                    <tr key={line.playerId}>
                      <td>{nameOf(line.playerId)}</td>
                      <td className="num">{line.blocksPlayed}</td>
                      <td className="num">
                        {symbol}
                        {formatMoney(line.amount)}
                      </td>
                      <td>
                        {line.method ? (
                          PAYMENT_METHOD_LABELS[line.method]
                        ) : (
                          <span className="pill wait">not chosen</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>Total</th>
                    <th className="num">{payments.totalBlocksPlayed}</th>
                    <th className="num">
                      {symbol}
                      {formatMoney(payments.totalCollected)}
                    </th>
                    <th />
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>

      {/* -------------------------------------------------------- messages --- */}
      <div className="card">
        <h2>Messages for the group</h2>
        <p className="small muted">
          Copy and paste into WhatsApp. Nothing is sent automatically.
        </p>

        <details open>
          <summary>
            <strong>Open for signups</strong>
          </summary>
          <pre className="message">{signupOpenMessage(session)}</pre>
          <CopyButton text={signupOpenMessage(session)} />
        </details>

        <details style={{ marginTop: 14 }}>
          <summary>
            <strong>Who is in, and places left</strong>
          </summary>
          {(() => {
            const text = availabilityMessage({
              session,
              confirmed: allocation.confirmed,
              reserves: allocation.reserves,
              capacity,
              playerName: nameOf,
            });
            return (
              <>
                <pre className="message">{text}</pre>
                <CopyButton text={text} />
              </>
            );
          })()}
        </details>

        {rounds.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary>
              <strong>Line-ups</strong>
            </summary>
            {(() => {
              const text = scheduleMessage({ session, rounds, playerName: nameOf });
              return (
                <>
                  <pre className="message">{text}</pre>
                  <CopyButton text={text} />
                </>
              );
            })()}
          </details>
        )}

        {payments.lines.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary>
              <strong>Payment schedule</strong>
            </summary>
            {(() => {
              const text = paymentMessage({ session, schedule: payments, playerName: nameOf });
              return (
                <>
                  <pre className="message">{text}</pre>
                  <CopyButton text={text} />
                </>
              );
            })()}
          </details>
        )}
      </div>

      {/* ------------------------------------------------------------ setup -- */}
      <div className="card">
        <details>
          <summary>
            <strong>Mixin setup</strong> <span className="muted small">— courts, times, cost</span>
          </summary>
          <form action={updateSessionAction} style={{ marginTop: 14 }}>
            <input type="hidden" name="sessionId" value={session.id} />
            <div className="row">
              <div className="field">
                <label htmlFor="name">Name</label>
                <input id="name" name="name" defaultValue={session.name} />
              </div>
              <div className="field">
                <label htmlFor="date">Date</label>
                <input id="date" name="date" type="date" defaultValue={session.date} />
              </div>
              <div className="field">
                <label htmlFor="startTime">Start time</label>
                <input
                  id="startTime"
                  name="startTime"
                  type="time"
                  step={1800}
                  defaultValue={formatTime(session.startMinutes)}
                />
              </div>
              <div className="field">
                <label htmlFor="slotCount">Half-hours</label>
                <input
                  id="slotCount"
                  name="slotCount"
                  type="number"
                  min={1}
                  max={16}
                  defaultValue={session.slotCount}
                />
              </div>
            </div>

            <h3>Courts</h3>
            <CourtPicker
              defaultStart={formatTime(session.startMinutes)}
              defaultSlots={session.slotCount}
              selected={session.courts.map((court) => ({
                courtNumber: court.courtNumber,
                start: formatTime(court.startMinutes),
                slots: court.slotCount,
              }))}
            />

            <div className="row" style={{ marginTop: 14 }}>
              <div className="field">
                <label htmlFor="costPerPlayer">Cost per person</label>
                <input
                  id="costPerPlayer"
                  name="costPerPlayer"
                  inputMode="decimal"
                  defaultValue={formatMoney(session.costPerPlayer)}
                />
              </div>
              <div className="field">
                <label htmlFor="status">Status</label>
                <select id="status" name="status" defaultValue={session.status}>
                  <option value="OPEN">Open for signups</option>
                  <option value="CLOSED">Signups closed</option>
                  <option value="SCHEDULED">Line-ups drawn</option>
                  <option value="COMPLETE">Finished</option>
                </select>
              </div>
            </div>

            <div className="actions">
              <button type="submit" className="primary">
                Save setup
              </button>
            </div>
          </form>

          <hr style={{ margin: "18px 0", border: 0, borderTop: "1px solid var(--border)" }} />
          <form action={deleteSessionAction}>
            <input type="hidden" name="sessionId" value={session.id} />
            <button type="submit" className="danger">
              Delete this mixin
            </button>
            <p className="small muted">
              Removes its signups and line-ups. Player ratings and other mixins are untouched.
            </p>
          </form>
        </details>
      </div>
    </>
  );
}
