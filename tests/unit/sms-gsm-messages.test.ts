import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeSmsSegments } from "@/lib/sms/gsm";

describe("GSM-7 analyzer", () => {
  it("counts extension-table characters as two septets", () => {
    expect(analyzeSmsSegments("A^{}\\[~]|EUR \u20ac")).toEqual({
      encoding: "GSM-7",
      units: 23,
      segments: 1,
    });
  });

  it("detects UCS-2 and uses UTF-16 units", () => {
    expect(analyzeSmsSegments("cart \ud83d\uded2")).toEqual({
      encoding: "UCS-2",
      units: 7,
      segments: 1,
    });
    expect(analyzeSmsSegments("\u201cUnicode quote\u201d").encoding).toBe(
      "UCS-2",
    );
  });

  it("uses concatenated-message capacities after the first segment", () => {
    expect(analyzeSmsSegments("a".repeat(161)).segments).toBe(2);
    expect(analyzeSmsSegments("\u2603".repeat(71)).segments).toBe(2);
  });
});

describe("authoritative SQL message literals", () => {
  it("keeps every Panther Carts SQL literal in one GSM-7 segment", () => {
    const migrationFiles = [
      "../../supabase/migrations/20260811120000_admin_dashboard.sql",
      "../../supabase/migrations/20260812120000_two_way_sms.sql",
    ];
    const messages = migrationFiles.flatMap((relativePath) => {
      const source = readFileSync(
        fileURLToPath(new URL(relativePath, import.meta.url)),
        "utf8",
      );
      return [...source.matchAll(/'(Panther Carts:[^']+)'/g)].map(
        (match) => match[1],
      );
    });

    expect(messages.length).toBeGreaterThan(15);
    for (const message of messages) {
      expect(analyzeSmsSegments(message), message).toMatchObject({
        encoding: "GSM-7",
        segments: 1,
      });
    }
  });
});
