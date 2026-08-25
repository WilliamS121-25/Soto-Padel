"use client";

import { useState } from "react";
import { FACILITY_COURTS } from "@/domain/types";

export interface CourtSelection {
  courtNumber: number;
  start: string;
  slots: number;
}

/**
 * Pick which of the club's five courts are booked, and when each one starts.
 *
 * Each court carries its own start time and length rather than inheriting the
 * mixin's, because courts are usually booked in staggered blocks — the mixin
 * opens at 18:00 on two courts and a third joins at 19:00.
 */
export function CourtPicker({
  defaultStart,
  defaultSlots,
  selected = [],
}: {
  defaultStart: string;
  defaultSlots: number;
  selected?: CourtSelection[];
}) {
  const chosen = new Map(selected.map((court) => [court.courtNumber, court]));
  const [on, setOn] = useState<Record<number, boolean>>(
    Object.fromEntries(FACILITY_COURTS.map((n) => [n, chosen.has(n)])),
  );

  return (
    <div className="courtpick">
      {FACILITY_COURTS.map((number) => {
        const existing = chosen.get(number);
        const active = on[number] ?? false;
        return (
          <div key={number} className={active ? "courtrow" : "courtrow off"}>
            <label className="check">
              <input
                type="checkbox"
                name={`court-${number}`}
                defaultChecked={chosen.has(number)}
                onChange={(event) => setOn((prev) => ({ ...prev, [number]: event.target.checked }))}
              />
              Court {number}
            </label>

            <div className="field">
              <label htmlFor={`court-${number}-start`}>Starts</label>
              <input
                id={`court-${number}-start`}
                type="time"
                name={`court-${number}-start`}
                step={1800}
                defaultValue={existing?.start ?? defaultStart}
                disabled={!active}
              />
            </div>

            <div className="field">
              <label htmlFor={`court-${number}-slots`}>Half-hours</label>
              <input
                id={`court-${number}-slots`}
                type="number"
                name={`court-${number}-slots`}
                min={1}
                max={16}
                defaultValue={existing?.slots ?? defaultSlots}
                disabled={!active}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
