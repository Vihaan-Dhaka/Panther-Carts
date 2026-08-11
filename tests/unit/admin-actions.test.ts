import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("next/cache", () => ({ refresh: mocks.refresh }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({})),
}));
vi.mock("@/lib/admin/dashboard", () => ({
  executeAddAdminBins: vi.fn(),
  executeConfigureAdminSession: vi.fn(),
  executeCreateAdminSession: mocks.createSession,
  executeEndAdminSession: vi.fn(),
  executeNotifyAdminRental: vi.fn(),
  executeStartAdminSession: vi.fn(),
}));

import { createSessionAction } from "@/app/admin/actions";

afterEach(() => {
  vi.clearAllMocks();
});

describe("admin Server Action refresh behavior", () => {
  it("does not convert a post-commit refresh exception into a mutation failure", async () => {
    mocks.createSession.mockResolvedValue({
      status: "success",
      message: "Draft created.",
    });
    mocks.refresh.mockImplementation(() => {
      throw new Error("refresh control flow");
    });

    await expect(createSessionAction(new FormData())).rejects.toThrow(
      /refresh control flow/,
    );
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("still maps an operation exception to the safe action error", async () => {
    mocks.createSession.mockRejectedValue(new Error("raw database detail"));
    const result = await createSessionAction(new FormData());
    expect(result).toEqual({
      status: "error",
      message: "We could not complete that admin action. Please try again.",
      fieldErrors: {},
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
