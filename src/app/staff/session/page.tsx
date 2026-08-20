import { redirect } from "next/navigation";
import { StaffStation } from "@/components/staff/staff-station";
import { AuthorizationError } from "@/lib/auth/admin";
import { requireStaffSession } from "@/lib/auth/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  confirmCheckout,
  confirmReturn,
  lookupCheckout,
  lookupReturn,
} from "./actions";

export default async function StaffSessionPage() {
  try {
    await requireStaffSession(createAdminClient());
  } catch (error) {
    if (error instanceof AuthorizationError) redirect("/staff");
    throw error;
  }

  return (
    <main className="min-h-full flex-1 bg-slate-100 px-4 py-8 sm:px-6 lg:py-12">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 rounded-[2rem] bg-slate-950 px-6 py-8 text-white shadow-xl shadow-slate-300/50 sm:px-9">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-sky-300">
            Panther Carts
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Staff station
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            Complete cart checkout and return at the physical service station.
          </p>
        </header>
        <StaffStation
          checkoutLookupAction={lookupCheckout}
          checkoutConfirmationAction={confirmCheckout}
          returnLookupAction={lookupReturn}
          returnConfirmationAction={confirmReturn}
        />
      </div>
    </main>
  );
}
