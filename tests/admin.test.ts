import { describe, expect, it } from "vitest";
import { cleanAdminName, DEFAULT_ADMIN_NAME } from "@/lib/admin";

/**
 * There is no authentication to test. The name is a label recorded against
 * changes, so what matters is that it is always usable for display and audit —
 * never empty, never unbounded.
 */
describe("the display name recorded against changes", () => {
  it("keeps an ordinary name as typed", () => {
    expect(cleanAdminName("William")).toBe("William");
    expect(cleanAdminName("Ana Lopez")).toBe("Ana Lopez");
  });

  it("trims and collapses whitespace", () => {
    expect(cleanAdminName("  William  ")).toBe("William");
    expect(cleanAdminName("Ana    Lopez")).toBe("Ana Lopez");
    expect(cleanAdminName("Ana\tLopez")).toBe("Ana Lopez");
  });

  it("falls back to a default rather than storing nothing", () => {
    expect(cleanAdminName("")).toBe(DEFAULT_ADMIN_NAME);
    expect(cleanAdminName("   ")).toBe(DEFAULT_ADMIN_NAME);
  });

  it("bounds the length so it cannot break the layout or the audit trail", () => {
    const long = "x".repeat(500);
    expect(cleanAdminName(long)).toHaveLength(40);
  });

  it("accepts anything a person might legitimately be called", () => {
    for (const name of ["José María", "O'Brien", "Anne-Marie", "李明"]) {
      expect(cleanAdminName(name)).toBe(name);
    }
  });
});
