import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CheckoutPreviewPanel,
  EligibleBinSelect,
  PantherCardConfirmation,
  ReturnPreviewPanel,
  WorkflowSuccess,
} from "@/components/staff/workflow-panels";
import {
  claimSubmission,
  releaseSubmission,
} from "@/components/staff/submission-guard";

const studentWithPrivateExtras = {
  fullName: "Jordan Panther",
  pantherId: "900123456",
  email: "private@example.edu",
  phone: "+14045550123",
  id: "internal-student-id",
};

describe("staff station UI", () => {
  it("shows only full name and Panther ID in the checkout preview", () => {
    const html = renderToStaticMarkup(
      <CheckoutPreviewPanel
        preview={{
          student: studentWithPrivateExtras,
          eligibleBins: [{ binNumber: "1", reserved: true }],
        }}
      />,
    );

    expect(html).toContain("Jordan Panther");
    expect(html).toContain("900123456");
    expect(html).not.toMatch(/private@example|14045550123|internal-student-id/);
  });

  it("shows only full name, Panther ID, and bin in the return preview", () => {
    const html = renderToStaticMarkup(
      <ReturnPreviewPanel
        preview={{ student: studentWithPrivateExtras, binNumber: "014" }}
      />,
    );

    expect(html).toContain("Jordan Panther");
    expect(html).toContain("900123456");
    expect(html).toContain("Bin 014");
    expect(html).not.toMatch(/private@example|14045550123|internal-student-id/);
  });

  it("renders the reserved bin and AVAILABLE replacements as eligible choices", () => {
    const html = renderToStaticMarkup(
      <EligibleBinSelect
        bins={[
          { binNumber: "1", reserved: true },
          { binNumber: "2", reserved: false },
        ]}
        defaultValue="1"
      />,
    );

    expect(html).toContain("Bin 1 — reserved");
    expect(html).toContain("Bin 2 — available replacement");
    expect(html).toMatch(/<select[^>]*required/);
  });

  it.each([
    ["checkout" as const, "pantherCardCollected", "collected"],
    ["return" as const, "pantherCardReturned", "returned"],
  ])(
    "requires explicit physical PantherCard confirmation for %s",
    (workflow, name, verb) => {
      const html = renderToStaticMarkup(
        <PantherCardConfirmation workflow={workflow} defaultChecked={false} />,
      );

      expect(html).toContain(`name="${name}"`);
      expect(html).toMatch(/type="checkbox"[^>]*required/);
      expect(html).toContain(`physical PantherCard`);
      expect(html).toContain(verb);
    },
  );

  it.each(["checkout", "return"] as const)(
    "shows a clear %s success and safe replay state",
    (kind) => {
      const html = renderToStaticMarkup(
        <WorkflowSuccess
          kind={kind}
          student={studentWithPrivateExtras}
          binNumber="1"
          idempotentReplay
        />,
      );

      expect(html).toContain(
        kind === "checkout" ? "Checkout complete" : "Check-in complete",
      );
      expect(html).toContain("safe retry");
      expect(html).not.toMatch(
        /private@example|14045550123|internal-student-id/,
      );
    },
  );

  it("claims one submission and blocks duplicates until the attempt settles", () => {
    const lock = { current: false };

    expect(claimSubmission(lock)).toBe(true);
    expect(claimSubmission(lock)).toBe(false);
    releaseSubmission(lock);
    expect(claimSubmission(lock)).toBe(true);
  });
});
