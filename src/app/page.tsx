import Link from "next/link";

const interfaces = [
  {
    href: "/student/demo-session",
    title: "Student",
    description:
      "Session-specific signup link. Students sign up once, then interact entirely through SMS.",
  },
  {
    href: "/staff/demo-staff",
    title: "Staff",
    description:
      "Checkout and return station. Staff enter pickup codes and bin numbers to issue and receive carts.",
  },
  {
    href: "/admin",
    title: "Admin",
    description:
      "Session control, link generation, bin inventory, and live tables for rentals and the waitlist.",
  },
];

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 p-8">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">Panther Carts</h1>
        <p className="mt-2 text-lg text-gray-500">
          Cart rental queue management with SMS notifications
        </p>
      </div>
      <div className="grid w-full max-w-4xl gap-6 sm:grid-cols-3">
        {interfaces.map(({ href, title, description }) => (
          <Link
            key={href}
            href={href}
            className="rounded-lg border border-gray-200 p-6 transition-colors hover:border-gray-400 dark:border-gray-800 dark:hover:border-gray-600"
          >
            <h2 className="text-xl font-semibold">{title}</h2>
            <p className="mt-2 text-sm text-gray-500">{description}</p>
          </Link>
        ))}
      </div>
      <p className="text-sm text-gray-400">
        Student and staff links above use placeholder codes for development.
      </p>
    </main>
  );
}
