import type { Metadata } from "next";
import { ThankYou } from "@/components/registration/thank-you";

// Patient receipt: never indexed, cached or referred. The receipt token lives
// only in the URL fragment, which browsers never send to the server.
export const metadata: Metadata = {
  title: "You’re checked in | The Birthwave",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

export default async function ThankYouPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <ThankYou checkin kiosk={params.kiosk === "1"} />;
}
