import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { AdHeadSnippet } from "@/components/ads/AdHeadSnippet";
import { AdEligibilityProvider } from "@/components/ads/AdEligibilityProvider";
import { getSiteUrl } from "@/lib/siteUrl";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: {
    default: "Veriqen News — Open-source news aggregator",
    template: "%s · Veriqen News",
  },
  description:
    "An open-source news aggregator that clusters public RSS coverage into stories, timelines, and source comparisons.",
  openGraph: {
    siteName: "Veriqen News",
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full overflow-x-hidden antialiased`}
    >
      <body className="flex min-h-full flex-col overflow-x-hidden bg-background text-foreground">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AdEligibilityProvider>
            <a
              href="#main-content"
              className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-foreground"
            >
              Skip to content
            </a>
            <Header />
            <main id="main-content" className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6">
              {children}
            </main>
            <Footer />
            <AdHeadSnippet />
          </AdEligibilityProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
