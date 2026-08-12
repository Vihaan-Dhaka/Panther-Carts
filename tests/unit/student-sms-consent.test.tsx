// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StudentSignupForm } from "@/components/student/signup-form";

describe("student SMS consent", () => {
  it("renders a required unchecked, labelled transactional consent control", () => {
    render(<StudentSignupForm action={vi.fn()} />);
    const checkbox = screen.getByRole("checkbox", {
      name: /Panther Carts transactional cart-rental text messages/i,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.required).toBe(true);
    expect(document.body.textContent).toContain("Message frequency varies");
    expect(document.body.textContent).toContain(
      "Reply STOP to opt out or HELP for carrier help",
    );
    expect(document.body.textContent).toContain("Consent is not for marketing");
  });
});
