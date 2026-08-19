import { randomUUID } from "node:crypto";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AdminDashboard } from "@/components/admin/admin-dashboard";
import { AuthorizationError, requireAdmin } from "@/lib/auth/admin";
import { getAdminDashboardSnapshot } from "@/lib/admin/dashboard";
import type { AdminDashboardSnapshot } from "@/lib/admin/types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  addBinsAction,
  configureSessionAction,
  createSessionAction,
  endSessionAction,
  notifyRentalAction,
  startSessionAction,
  logoutAdminAction,
} from "./actions";

export default async function AdminPage() {
  await connection();
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AuthorizationError) redirect("/admin/login");
    throw error;
  }
  let snapshot: AdminDashboardSnapshot | null = null;
  let loadError: string | null = null;
  try {
    snapshot = await getAdminDashboardSnapshot(createAdminClient());
  } catch {
    loadError =
      "We could not load the admin dashboard right now. Check the server configuration and try again.";
  }

  if (!snapshot) {
    return (
      <main className="min-h-full flex-1 bg-slate-100 px-4 py-10 sm:px-6">
        <section className="mx-auto max-w-4xl rounded-[2rem] border border-red-200 bg-white p-8 shadow-lg">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-red-700">
            Panther Carts
          </p>
          <h1 className="mt-3 text-3xl font-bold text-slate-950">
            Admin Dashboard
          </h1>
          <p role="alert" className="mt-4 leading-7 text-slate-700">
            {loadError}
          </p>
        </section>
      </main>
    );
  }

  const activeRentalIds = new Set([
    ...snapshot.currentOutRentals.map((rental) => rental.rentalId),
    ...snapshot.currentLateRentals.map((rental) => rental.rentalId),
    ...snapshot.allLateRentals
      .filter((rental) => rental.rentalStatus === "OUT")
      .map((rental) => rental.rentalId),
    ...snapshot.sessionRentals
      .filter((rental) => rental.rentalStatus === "OUT")
      .map((rental) => rental.rentalId),
    ...snapshot.inventory.flatMap((bin) =>
      bin.currentRentalId ? [bin.currentRentalId] : [],
    ),
  ]);
  const notifyKeys = Object.fromEntries(
    [...activeRentalIds].map((rentalId) => [rentalId, randomUUID()]),
  );

  return (
    <main className="min-h-full flex-1 bg-slate-100 px-4 py-8 sm:px-6 lg:py-12">
      <div className="mx-auto mb-4 flex max-w-[96rem] justify-end">
        <form action={logoutAdminAction}>
          <button
            type="submit"
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-800"
          >
            Sign out
          </button>
        </form>
      </div>
      <AdminDashboard
        snapshot={snapshot}
        createSessionAction={createSessionAction}
        configureSessionAction={configureSessionAction}
        startSessionAction={startSessionAction}
        endSessionAction={endSessionAction}
        addBinsAction={addBinsAction}
        notifyRentalAction={notifyRentalAction}
        createSessionIdempotencyKey={randomUUID()}
        notifyIdempotencyKeys={notifyKeys}
      />
    </main>
  );
}
