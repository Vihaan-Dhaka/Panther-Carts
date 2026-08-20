import { connection } from "next/server";
import { redirect } from "next/navigation";
import { AdminLoginForm } from "@/components/admin/admin-login-form";
import { AuthorizationError, requireAdmin } from "@/lib/auth/admin";
import { loginAdminAction } from "./actions";

export default async function AdminLoginPage() {
  await connection();
  try {
    await requireAdmin();
    redirect("/admin");
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
  }

  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-slate-100 px-4 py-10">
      <section className="w-full max-w-md rounded-[2rem] border border-slate-200 bg-white p-8 shadow-xl">
        <p className="text-sm font-bold uppercase tracking-[0.2em] text-sky-700">
          Panther Carts
        </p>
        <h1 className="mt-3 text-3xl font-bold text-slate-950">
          Admin sign in
        </h1>
        <p className="mt-3 leading-7 text-slate-600">
          Use an administrator account provisioned in Supabase Auth.
        </p>
        <AdminLoginForm action={loginAdminAction} />
      </section>
    </main>
  );
}
