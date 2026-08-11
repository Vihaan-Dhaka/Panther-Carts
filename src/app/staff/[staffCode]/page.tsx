import { StaffStation } from "@/components/staff/staff-station";
import { getStaffStationAvailability } from "@/lib/queue/staff-station";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  confirmCheckout,
  confirmReturn,
  lookupCheckout,
  lookupReturn,
} from "./actions";

export default async function StaffSessionPage({
  params,
}: PageProps<"/staff/[staffCode]">) {
  const { staffCode } = await params;
  let availability;

  try {
    availability = await getStaffStationAvailability(
      createAdminClient(),
      staffCode,
    );
  } catch {
    availability = {
      available: false as const,
      message:
        "We could not check this staff session right now. Please try again.",
    };
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

        {availability.available ? (
          <StaffStation
            checkoutLookupAction={lookupCheckout.bind(null, staffCode)}
            checkoutConfirmationAction={confirmCheckout.bind(null, staffCode)}
            returnLookupAction={lookupReturn.bind(null, staffCode)}
            returnConfirmationAction={confirmReturn.bind(null, staffCode)}
          />
        ) : (
          <section className="rounded-[2rem] border border-red-200 bg-white p-8 shadow-lg">
            <h2 className="text-2xl font-bold text-slate-950">
              Staff station unavailable
            </h2>
            <p role="alert" className="mt-3 max-w-2xl leading-7 text-slate-600">
              {availability.message}
            </p>
          </section>
        )}
      </div>
    </main>
  );
}
