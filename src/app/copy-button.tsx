"use client";

import { useState } from "react";

/**
 * Copies a generated message so it can be pasted into the WhatsApp group.
 * The app deliberately does not talk to WhatsApp itself — copy and paste needs
 * no API access, no business account and no approval for message templates.
 */
export function CopyButton({ text, label = "Copy for WhatsApp" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  }

  return (
    <button type="button" className="primary" onClick={copy}>
      {state === "done" ? "Copied" : state === "failed" ? "Press Ctrl+C instead" : label}
    </button>
  );
}
