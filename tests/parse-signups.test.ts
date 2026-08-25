import { describe, expect, it } from "vitest";
import { parseSignupText } from "@/domain/parse-signups";
import { parseTime } from "@/domain/time";

describe("reading signups pasted out of WhatsApp", () => {
  it("handles the dash-separated list an admin would type", () => {
    const parsed = parseSignupText(
      ["Ana — 3 — 18:00", "Luis - 2 - 19:30", "Marta, 4, 18:30"].join("\n"),
    );
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({ name: "Ana", games: 3, startMinutes: parseTime("18:00") });
    expect(parsed[1]).toMatchObject({ name: "Luis", games: 2, startMinutes: parseTime("19:30") });
    expect(parsed[2]).toMatchObject({ name: "Marta", games: 4, startMinutes: parseTime("18:30") });
    for (const line of parsed) expect(line.problems).toEqual([]);
  });

  it("handles a raw WhatsApp export, taking the name from the sender", () => {
    const parsed = parseSignupText(
      "[28/08/2025, 18:04] Javi: 3 games from 18:30\n" +
        "28/08/2025, 18:06 - Sofia: 2 games please 19:00",
    );
    expect(parsed[0]).toMatchObject({ name: "Javi", games: 3, startMinutes: parseTime("18:30") });
    expect(parsed[1]).toMatchObject({ name: "Sofia", games: 2, startMinutes: parseTime("19:00") });
  });

  it("understands 12-hour and continental time", () => {
    const parsed = parseSignupText("Pedro 2 games 6pm\nCarlos 3 juegos 18h30\nElena 1 game 7.30pm");
    expect(parsed[0]?.startMinutes).toBe(parseTime("18:00"));
    expect(parsed[1]?.startMinutes).toBe(parseTime("18:30"));
    expect(parsed[2]?.startMinutes).toBe(parseTime("19:30"));
  });

  it("understands Spanish game words", () => {
    const parsed = parseSignupText("Rocio 4 partidos 18:00");
    expect(parsed[0]).toMatchObject({ name: "Rocio", games: 4 });
  });

  it("rounds an off-grid time up to the next half hour and says so", () => {
    const parsed = parseSignupText("Ana 2 18:15");
    expect(parsed[0]?.startMinutes).toBe(parseTime("18:30"));
    expect(parsed[0]?.problems.join(" ")).toMatch(/rounded up/i);
  });

  it("falls back to the session defaults when a line is vague", () => {
    const parsed = parseSignupText("Tomas", {
      games: 2,
      startMinutes: parseTime("18:00"),
    });
    expect(parsed[0]).toMatchObject({
      name: "Tomas",
      games: 2,
      startMinutes: parseTime("18:00"),
    });
  });

  it("reports what it could not work out rather than guessing", () => {
    const parsed = parseSignupText("Tomas");
    expect(parsed[0]?.games).toBeNull();
    expect(parsed[0]?.startMinutes).toBeNull();
    expect(parsed[0]?.problems).toHaveLength(2);
  });

  it("skips WhatsApp's own noise", () => {
    const parsed = parseSignupText(
      [
        "Messages and calls are end-to-end encrypted.",
        "<Media omitted>",
        "Ana — 3 — 18:00",
        "",
        "   ",
      ].join("\n"),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe("Ana");
  });

  it("does not mistake the time for the number of games", () => {
    const parsed = parseSignupText("Ana 18:30", { games: 1 });
    expect(parsed[0]?.startMinutes).toBe(parseTime("18:30"));
    expect(parsed[0]?.games).toBe(1);
    expect(parsed[0]?.name).toBe("Ana");
  });

  it("keeps surnames but drops filler and emoji", () => {
    const parsed = parseSignupText("Ana Maria Lopez 3 games from 18:00 thanks 🎾");
    expect(parsed[0]?.name).toBe("Ana Maria Lopez");
  });

  it("keeps the raw line so an admin can check it", () => {
    const parsed = parseSignupText("Ana — 3 — 18:00");
    expect(parsed[0]?.raw).toBe("Ana — 3 — 18:00");
  });
});
