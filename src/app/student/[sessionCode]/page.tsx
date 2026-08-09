interface StudentSessionPageProps {
  params: Promise<{ sessionCode: string }>;
}

export default async function StudentSessionPage({
  params,
}: StudentSessionPageProps) {
  const { sessionCode } = await params;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-bold">Student Signup</h1>
      <p className="text-gray-500">
        Session: <code className="font-mono">{sessionCode}</code>
      </p>
      <p className="max-w-md text-center text-sm text-gray-400">
        Placeholder — the signup form (full name, Panther ID, student email,
        phone number) will be implemented in Ticket 2.
      </p>
    </main>
  );
}
