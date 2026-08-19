import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

import { AuthorizationError, requireAdmin } from "@/lib/auth/admin";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("admin authorization", () => {
  it("accepts only a freshly verified Supabase user with the admin app role", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9",
          app_metadata: { role: "admin" },
        },
      },
      error: null,
    });
    await expect(requireAdmin()).resolves.toEqual({
      userId: "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9",
    });
  });

  it.each([
    [null, null],
    [{ id: "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9", app_metadata: {} }, null],
    [
      {
        id: "9ce0f6b4-63b0-48b0-bb5b-0fe117e640a9",
        app_metadata: { role: "staff" },
      },
      null,
    ],
    [null, { message: "private auth error" }],
  ])(
    "denies missing, non-admin, and failed identities",
    async (user, error) => {
      mocks.getUser.mockResolvedValue({ data: { user }, error });
      await expect(requireAdmin()).rejects.toBeInstanceOf(AuthorizationError);
    },
  );
});
