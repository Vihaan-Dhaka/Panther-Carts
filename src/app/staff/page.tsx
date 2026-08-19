import { z } from "zod";
import { StaffAccessForm } from "@/components/staff/staff-access-form";
import { verifyStaffAccessCodeAction } from "./actions";

const errorSchema = z.enum(["invalid", "limited", "unavailable"]);

export default async function StaffAccessPage({
  searchParams,
}: PageProps<"/staff">) {
  const rawError = (await searchParams).error;
  const parsedError = errorSchema.safeParse(rawError);
  const message = parsedError.success
    ? "Staff access was not accepted. Check the link or code and try again later."
    : null;

  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-slate-100 px-4 py-10">
      <section className="w-full max-w-md rounded-[2rem] border border-slate-200 bg-white p-8 shadow-xl">
        <p className="text-sm font-bold uppercase tracking-[0.2em] text-sky-700">
          Panther Carts
        </p>
        <h1 className="mt-3 text-3xl font-bold text-slate-950">Staff access</h1>
        <p className="mt-3 leading-7 text-slate-600">
          Open the generated staff link or enter the session’s access code.
        </p>
        {message && (
          <p
            role="alert"
            className="mt-5 rounded-xl bg-red-50 p-3 text-red-800"
          >
            {message}
          </p>
        )}
        <StaffAccessForm action={verifyStaffAccessCodeAction} />
      </section>
    </main>
  );
}
