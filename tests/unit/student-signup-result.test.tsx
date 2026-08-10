import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudentSignupResult } from "@/components/student/signup-result";

describe("StudentSignupResult", () => {
  it("shows the PostgreSQL pickup code for READY", () => {
    const html = renderToStaticMarkup(
      <StudentSignupResult result={{ status: "READY", pickupCode: "0427" }} />,
    );

    expect(html).toContain("Cart ready");
    expect(html).toContain("0427");
    expect(html).toContain("four-digit pickup code");
  });

  it("shows WAITING position and an available estimate without a code", () => {
    const html = renderToStaticMarkup(
      <StudentSignupResult
        result={{
          status: "WAITING",
          position: 3,
          estimatedWaitMinutes: 18,
        }}
      />,
    );

    expect(html).toContain("Queue position 3");
    expect(html).toContain("about 18 minutes");
    expect(html).toContain("No pickup code is assigned");
  });

  it("states clearly when the WAITING estimate is unavailable", () => {
    const html = renderToStaticMarkup(
      <StudentSignupResult
        result={{
          status: "WAITING",
          position: 1,
          estimatedWaitMinutes: null,
        }}
      />,
    );

    expect(html).toContain("estimated wait is not available yet");
    expect(html).toContain("will not guess");
  });
});
