interface StaffSessionPageProps {
  params: Promise<{ staffCode: string }>;
}

export default async function StaffSessionPage({
  params,
}: StaffSessionPageProps) {
  const { staffCode } = await params;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-bold">Staff Station</h1>
      <p className="text-gray-500">
        Access code: <code className="font-mono">{staffCode}</code>
      </p>
      <p className="max-w-md text-center text-sm text-gray-400">
        Placeholder — checkout (pickup code, bin selection, PantherCard
        collection) and return (bin number, PantherCard return) will be
        implemented in Ticket 3.
      </p>
    </main>
  );
}
