import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Clinic Registration | The Birthwave",
  robots: { index: false, follow: false },
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const kiosk = params.kiosk === "1" ? "?kiosk=1" : "";
  redirect(`/registration${kiosk}`);
}
