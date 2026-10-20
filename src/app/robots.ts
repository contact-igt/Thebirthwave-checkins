import type { MetadataRoute } from "next";

/** The check-in app handles confidential patient data and is never crawled. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
