// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminDashboard } from "@/components/admin/admin-dashboard";
import type {
  AdminActionResult,
  AdminDashboardSnapshot,
  AdminRentalRow,
} from "@/lib/admin/types";

const RENTAL_ID = "81bbf354-a557-4d22-9da0-6574416c62f1";
const RETURNED_ID = "42aa10ce-237f-45c7-9345-29466cb33dbc";
const KEY = "7b830507-034f-4746-9a67-f7e9184d40bc";
const NOW = "2026-08-11T15:00:00.000Z";

const activeRental: AdminRentalRow = {
  rentalId: RENTAL_ID,
  binNumber: "1",
  fullName: "Jordan Panther",
  pantherId: "900123456",
  email: "jordan@example.edu",
  phone: "+14045550123",
  rentalStatus: "OUT",
  checkedOutAt: NOW,
  dueAt: "2026-08-11T14:00:00.000Z",
  returnedAt: null,
  wasLate: false,
  isCurrentlyLate: true,
  visualStatus: "currently-late",
  statusText: "Checked out — late",
};

const returnedRental: AdminRentalRow = {
  ...activeRental,
  rentalId: RETURNED_ID,
  binNumber: "2",
  rentalStatus: "RETURNED",
  returnedAt: NOW,
  wasLate: true,
  isCurrentlyLate: false,
  visualStatus: "returned-late",
  statusText: "Returned late",
};

function snapshot(): AdminDashboardSnapshot {
  return {
    session: {
      name: "Fall service",
      status: "ACTIVE",
      studentCode: "signup-code",
      staffCode: "staff-code",
      studentLink: "https://example.test/student/signup-code",
      staffLink: "https://example.test/staff/staff-code",
      rentalDurationMinutes: 60,
      pickupWindowMinutes: 10,
      createdAt: NOW,
      startedAt: NOW,
      endedAt: null,
    },
    overview: {
      totalBins: 2,
      availableBins: 1,
      reservedBins: 0,
      checkedOutBins: 1,
      currentLateRentals: 1,
      currentWaitlist: 1,
    },
    currentLateRentals: [activeRental],
    allLateRentals: [activeRental, returnedRental],
    currentOutRentals: [activeRental],
    inventory: [
      {
        binNumber: "1",
        binStatus: "OUT",
        currentRentalId: RENTAL_ID,
        currentCheckedOutAt: NOW,
        currentDueAt: activeRental.dueAt,
        isCurrentlyLate: true,
        fullName: activeRental.fullName,
        pantherId: activeRental.pantherId,
        email: activeRental.email,
        phone: activeRental.phone,
        visualStatus: "currently-late",
        statusText: "Checked out — late",
      },
      {
        binNumber: "2",
        binStatus: "AVAILABLE",
        currentRentalId: null,
        currentCheckedOutAt: null,
        currentDueAt: null,
        isCurrentlyLate: false,
        fullName: null,
        pantherId: null,
        email: null,
        phone: null,
        visualStatus: "available",
        statusText: "Available",
      },
    ],
    sessionRentals: [activeRental, returnedRental],
    waitlist: [
      {
        queueEntryId: "15f7d61c-a959-447c-bb3f-da59561b90a2",
        position: 1,
        joinedAt: NOW,
        fullName: "Casey Student",
        pantherId: "900987654",
        email: "casey@example.edu",
        phone: "+14045550999",
      },
    ],
  };
}

const success: AdminActionResult = {
  status: "success",
  message: "Done.",
};

function props(overrides: Record<string, unknown> = {}) {
  const action = vi.fn(async () => success);
  return {
    snapshot: snapshot(),
    createSessionAction: action,
    configureSessionAction: action,
    startSessionAction: action,
    endSessionAction: action,
    addBinsAction: action,
    notifyRentalAction: action,
    createSessionIdempotencyKey: KEY,
    notifyIdempotencyKeys: { [RENTAL_ID]: KEY },
    ...overrides,
  };
}

afterEach(cleanup);

describe("admin dashboard client behavior", () => {
  it("renders exactly seven accessible table choices and switches every view", () => {
    render(<AdminDashboard {...props()} />);
    const selector = screen.getByLabelText("Table view") as HTMLSelectElement;
    expect([...selector.options].map((option) => option.text)).toEqual([
      "Overview",
      "Current late rentals",
      "All late rentals in the session, including returned rentals",
      "Currently checked out",
      "Total inventory",
      "All rentals in the session",
      "Current waitlist",
    ]);
    expect(screen.getAllByText("Total inventory").length).toBeGreaterThan(0);

    for (const [value, tableName] of [
      ["current-late", "Current late rentals"],
      ["all-late", "All late rentals in the session"],
      ["checked-out", "Currently checked out rentals"],
      ["inventory", "Total inventory for the current session"],
      ["rentals", "All rentals in the session"],
      ["waitlist", "Current waitlist for the session"],
    ]) {
      fireEvent.change(selector, { target: { value } });
      expect(screen.getByRole("table", { name: tableName })).toBeTruthy();
    }
  });

  it("pairs visual colors with readable status text and Notify only on active rentals", () => {
    render(<AdminDashboard {...props()} />);
    const selector = screen.getByLabelText("Table view");
    fireEvent.change(selector, { target: { value: "rentals" } });
    const rentalsTable = screen.getByRole("table", {
      name: "All rentals in the session",
    });
    expect(
      within(rentalsTable).getByText("Checked out — late").className,
    ).toContain("bg-red-100");
    expect(within(rentalsTable).getByText("Returned late").className).toContain(
      "bg-orange-100",
    );
    expect(screen.getAllByRole("button", { name: "Notify" })).toHaveLength(1);
    expect(within(rentalsTable).getAllByText("Returned")).toHaveLength(2);

    fireEvent.change(selector, { target: { value: "inventory" } });
    const inventoryTable = screen.getByRole("table", {
      name: "Total inventory for the current session",
    });
    expect(within(inventoryTable).getByText("Available").className).toContain(
      "bg-white",
    );
  });

  it("blocks duplicate Notify submissions while the first request is pending", async () => {
    let resolve: (value: AdminActionResult) => void = () => undefined;
    const notifyRentalAction = vi.fn(
      () =>
        new Promise<AdminActionResult>((done) => {
          resolve = done;
        }),
    );
    render(<AdminDashboard {...props({ notifyRentalAction })} />);
    fireEvent.change(screen.getByLabelText("Table view"), {
      target: { value: "checked-out" },
    });
    const button = screen.getByRole("button", { name: "Notify" });
    const form = button.closest("form");
    if (!form) throw new Error("Notify must belong to a form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(notifyRentalAction).toHaveBeenCalledTimes(1));
    await act(async () => resolve(success));
  });

  it("announces clear empty states", () => {
    const empty = snapshot();
    empty.currentLateRentals = [];
    empty.inventory = [];
    empty.waitlist = [];
    render(<AdminDashboard {...props({ snapshot: empty })} />);
    const selector = screen.getByLabelText("Table view");
    fireEvent.change(selector, { target: { value: "current-late" } });
    expect(
      screen.getByText("No records in this view.").getAttribute("role"),
    ).toBe("status");
    fireEvent.change(selector, { target: { value: "inventory" } });
    expect(
      screen.getByText("No bins have been added to this session."),
    ).toBeTruthy();
    fireEvent.change(selector, { target: { value: "waitlist" } });
    expect(screen.getByText("The current waitlist is empty.")).toBeTruthy();
  });
});
