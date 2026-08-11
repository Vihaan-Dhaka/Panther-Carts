// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffStation } from "@/components/staff/staff-station";
import type {
  CheckoutConfirmationState,
  CheckoutLookupState,
  ReturnConfirmationState,
  ReturnLookupState,
} from "@/lib/queue/staff-station";

const KEY = "7b830507-034f-4746-9a67-f7e9184d40bc";
const student = { fullName: "Jordan Panther", pantherId: "900123456" };

type StaffStationProps = ComponentProps<typeof StaffStation>;

const checkoutPreview: CheckoutLookupState = {
  status: "preview",
  values: { pickupCode: "0427" },
  preview: {
    student,
    eligibleBins: [
      { binNumber: "1", reserved: true },
      { binNumber: "2", reserved: false },
    ],
  },
  idempotencyKey: KEY,
};

const returnPreview: ReturnLookupState = {
  status: "preview",
  values: { binNumber: "1" },
  preview: { student, binNumber: "1" },
  idempotencyKey: KEY,
};

const checkoutSuccess: CheckoutConfirmationState = {
  status: "success",
  result: {
    student,
    binNumber: "1",
    idempotentReplay: false,
  },
};

const returnSuccess: ReturnConfirmationState = {
  status: "success",
  result: {
    student,
    binNumber: "1",
    idempotentReplay: false,
  },
};

function stationProps(
  overrides: Partial<StaffStationProps> = {},
): StaffStationProps {
  return {
    checkoutLookupAction: async () => checkoutPreview,
    checkoutConfirmationAction: async () => checkoutSuccess,
    returnLookupAction: async () => returnPreview,
    returnConfirmationAction: async () => returnSuccess,
    ...overrides,
  };
}

function submitFormFor(control: HTMLElement) {
  const form = control.closest("form");
  if (!form) {
    throw new Error("Expected the control to belong to a form");
  }
  fireEvent.submit(form);
}

async function openCheckoutPreview() {
  const pickupCode = screen.getByLabelText("Four-digit pickup code");
  fireEvent.change(pickupCode, { target: { value: "0427" } });
  submitFormFor(pickupCode);
  return screen.findByRole("heading", {
    name: "Confirm the physical handoff",
  });
}

async function openReturnPreview() {
  const binNumber = screen.getByLabelText("Physical bin number");
  fireEvent.change(binNumber, { target: { value: "1" } });
  submitFormFor(binNumber);
  return screen.findByRole("heading", {
    name: "Return the physical PantherCard",
  });
}

afterEach(() => {
  cleanup();
});

describe("staff station client transitions", () => {
  it("moves focus through checkout preview and success", async () => {
    render(<StaffStation {...stationProps()} />);

    const previewHeading = await openCheckoutPreview();
    await waitFor(() => expect(document.activeElement).toBe(previewHeading));

    const card = screen.getByLabelText(
      /I collected the student.s physical PantherCard/,
    );
    fireEvent.click(card);
    submitFormFor(card);

    const successHeading = await screen.findByRole("heading", {
      name: "Bin 1 is checked out.",
    });
    await waitFor(() => expect(document.activeElement).toBe(successHeading));
  });

  it("moves focus through return preview and success", async () => {
    render(<StaffStation {...stationProps()} />);

    const previewHeading = await openReturnPreview();
    await waitFor(() => expect(document.activeElement).toBe(previewHeading));

    const card = screen.getByLabelText(
      "I returned the physical PantherCard to the student.",
    );
    fireEvent.click(card);
    submitFormFor(card);

    const successHeading = await screen.findByRole("heading", {
      name: "Bin 1 was returned.",
    });
    await waitFor(() => expect(document.activeElement).toBe(successHeading));
  });

  it("remounts the bin select and drops a rejected bin after refresh failure", async () => {
    const checkoutConfirmationAction = vi.fn(async () => ({
      status: "error" as const,
      values: { binNumber: "2", pantherCardCollected: true },
      fieldErrors: {
        binNumber: ["That bin is no longer eligible for checkout"],
      },
      formError: null,
      eligibleBinsRefreshAttempted: true,
    }));
    render(<StaffStation {...stationProps({ checkoutConfirmationAction })} />);
    await openCheckoutPreview();

    const originalSelect = screen.getByLabelText("Bin being issued");
    fireEvent.change(originalSelect, { target: { value: "2" } });
    const card = screen.getByLabelText(
      /I collected the student.s physical PantherCard/,
    );
    fireEvent.click(card);
    submitFormFor(card);

    const binError = await screen.findByText(
      "That bin is no longer eligible for checkout",
    );
    expect(binError.getAttribute("role")).toBe("alert");
    await waitFor(() =>
      expect(screen.getByLabelText("Bin being issued")).not.toBe(
        originalSelect,
      ),
    );
    const refreshedSelect = screen.getByLabelText(
      "Bin being issued",
    ) as HTMLSelectElement;
    expect(refreshedSelect.value).toBe("1");
    expect(refreshedSelect.querySelector('option[value="2"]')).toBeNull();

    submitFormFor(refreshedSelect);
    await waitFor(() =>
      expect(screen.getByLabelText("Bin being issued")).not.toBe(
        refreshedSelect,
      ),
    );
    expect(checkoutConfirmationAction).toHaveBeenCalledTimes(2);
  });

  it("announces checkout and return lookup field errors", async () => {
    const checkoutLookupAction: StaffStationProps["checkoutLookupAction"] =
      async () => ({
        status: "error",
        values: { pickupCode: "9999" },
        fieldErrors: { pickupCode: ["That pickup code is not valid"] },
        formError: null,
      });
    const returnLookupAction: StaffStationProps["returnLookupAction"] =
      async () => ({
        status: "error",
        values: { binNumber: "999" },
        fieldErrors: { binNumber: ["That bin does not exist"] },
        formError: null,
      });
    render(
      <StaffStation
        {...stationProps({ checkoutLookupAction, returnLookupAction })}
      />,
    );

    submitFormFor(screen.getByLabelText("Four-digit pickup code"));
    submitFormFor(screen.getByLabelText("Physical bin number"));

    const pickupError = await screen.findByText(
      "That pickup code is not valid",
    );
    const returnError = await screen.findByText("That bin does not exist");
    expect(pickupError.getAttribute("role")).toBe("alert");
    expect(returnError.getAttribute("role")).toBe("alert");
  });

  it("blocks duplicate confirmation submissions while one is pending", async () => {
    let resolveConfirmation: (state: CheckoutConfirmationState) => void = () =>
      undefined;
    const checkoutConfirmationAction = vi.fn(
      () =>
        new Promise<CheckoutConfirmationState>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    render(<StaffStation {...stationProps({ checkoutConfirmationAction })} />);
    await openCheckoutPreview();

    const card = screen.getByLabelText(
      /I collected the student.s physical PantherCard/,
    );
    fireEvent.click(card);
    submitFormFor(card);
    submitFormFor(card);

    await waitFor(() =>
      expect(checkoutConfirmationAction).toHaveBeenCalledTimes(1),
    );
    await act(async () => resolveConfirmation(checkoutSuccess));
  });
});
