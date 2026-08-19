import { StudentSignupForm } from "@/components/student/signup-form";
import { headers } from "next/headers";
import { consumeRateLimit, requestIp } from "@/lib/auth/rate-limit";
import { getStudentSignupAvailability } from "@/lib/queue/student-signup";
import { createAdminClient } from "@/lib/supabase/admin";
import { submitStudentSignup } from "./actions";

export default async function StudentSessionPage({
  params,
}: PageProps<"/student/[sessionCode]">) {
  const { sessionCode } = await params;
  let availability;

  try {
    const client = createAdminClient();
    const limit = await consumeRateLimit(
      client,
      "student_code_check",
      requestIp(await headers()),
      sessionCode.slice(0, 200),
    );
    if (!limit.allowed) {
      availability = {
        available: false as const,
        message: "This signup link is unavailable. Wait and try again.",
      };
    } else {
      availability = await getStudentSignupAvailability(client, sessionCode);
    }
  } catch {
    availability = {
      available: false as const,
      message:
        "We could not check this signup session right now. Please try again.",
    };
  }

  return (
    <main className="flex flex-1 items-center justify-center bg-slate-100 px-4 py-10 sm:px-6">
      <div className="w-full max-w-xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-xl shadow-slate-200/60">
        <header className="bg-slate-950 px-6 py-8 text-white sm:px-9">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-300">
            Panther Carts
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight">
            Student signup
          </h1>
          <p className="mt-3 max-w-md text-sm leading-6 text-slate-300">
            Join this session&apos;s cart queue. No account is required.
          </p>
        </header>

        <div className="p-6 sm:p-9">
          {availability.available ? (
            <StudentSignupForm
              action={submitStudentSignup.bind(null, availability.sessionCode)}
            />
          ) : (
            <section aria-labelledby="signup-unavailable-heading">
              <h2
                id="signup-unavailable-heading"
                className="text-xl font-bold text-slate-950"
              >
                Signup unavailable
              </h2>
              <p role="alert" className="mt-3 leading-7 text-slate-600">
                {availability.message}
              </p>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
