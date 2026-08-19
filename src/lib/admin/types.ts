export const ADMIN_VIEW_OPTIONS = [
  ["overview", "Overview"],
  ["current-late", "Current late rentals"],
  ["all-late", "All late rentals in the session, including returned rentals"],
  ["checked-out", "Currently checked out"],
  ["inventory", "Total inventory"],
  ["rentals", "All rentals in the session"],
  ["waitlist", "Current waitlist"],
] as const;

export type AdminViewKey = (typeof ADMIN_VIEW_OPTIONS)[number][0];

export type AdminSessionStatus = "DRAFT" | "ACTIVE" | "CLOSED";

export type AdminSessionDto = {
  name: string;
  status: AdminSessionStatus;
  studentCode: string;
  staffAccessCode: string | null;
  studentLink: string;
  staffLink: string | null;
  rentalDurationMinutes: number;
  pickupWindowMinutes: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
};

export type RentalVisualStatus =
  | "currently-late"
  | "checked-out-on-time"
  | "returned-late"
  | "returned-on-time";

export type AdminRentalRow = {
  rentalId: string;
  binNumber: string;
  fullName: string;
  pantherId: string;
  email: string;
  phone: string;
  rentalStatus: "OUT" | "RETURNED";
  checkedOutAt: string;
  dueAt: string;
  returnedAt: string | null;
  wasLate: boolean;
  isCurrentlyLate: boolean;
  visualStatus: RentalVisualStatus;
  statusText: string;
};

export type AdminInventoryRow = {
  binNumber: string;
  binStatus: "AVAILABLE" | "RESERVED" | "OUT";
  currentRentalId: string | null;
  currentCheckedOutAt: string | null;
  currentDueAt: string | null;
  isCurrentlyLate: boolean;
  fullName: string | null;
  pantherId: string | null;
  email: string | null;
  phone: string | null;
  visualStatus: RentalVisualStatus | "available" | "reserved";
  statusText: string;
};

export type AdminWaitlistRow = {
  queueEntryId: string;
  position: number;
  joinedAt: string;
  fullName: string;
  pantherId: string;
  email: string;
  phone: string;
};

export type AdminOverview = {
  totalBins: number;
  availableBins: number;
  reservedBins: number;
  checkedOutBins: number;
  currentLateRentals: number;
  currentWaitlist: number;
};

export type AdminDashboardSnapshot = {
  session: AdminSessionDto | null;
  overview: AdminOverview;
  currentLateRentals: AdminRentalRow[];
  allLateRentals: AdminRentalRow[];
  currentOutRentals: AdminRentalRow[];
  inventory: AdminInventoryRow[];
  sessionRentals: AdminRentalRow[];
  waitlist: AdminWaitlistRow[];
};

export type AdminFieldErrors = Partial<Record<string, string[]>>;

export type AdminActionResult =
  | {
      status: "success";
      message: string;
      addedBins?: string[];
      duplicateBins?: string[];
      idempotentReplay?: boolean;
    }
  | {
      status: "error";
      message: string | null;
      fieldErrors: AdminFieldErrors;
    };

export function classifyRentalStatus(input: {
  rentalStatus: "OUT" | "RETURNED";
  isCurrentlyLate: boolean;
  wasLate: boolean;
}): { visualStatus: RentalVisualStatus; statusText: string } {
  if (input.rentalStatus === "OUT") {
    return input.isCurrentlyLate
      ? { visualStatus: "currently-late", statusText: "Checked out — late" }
      : {
          visualStatus: "checked-out-on-time",
          statusText: "Checked out — on time",
        };
  }

  return input.wasLate
    ? { visualStatus: "returned-late", statusText: "Returned late" }
    : { visualStatus: "returned-on-time", statusText: "Returned on time" };
}
