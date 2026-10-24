import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import Script from "next/script";
import { THEME_BOOT_SCRIPT, THEME_COOKIE, isTheme } from "@/lib/theme";
import "./globals.css";

// Self-hosted at build time: no runtime request to a third-party font CDN.
const inter = Inter({ subsets: ["latin", "cyrillic"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Zewex Tools", template: "%s · Zewex Tools" },
  description: "Внутренний портал инструментов Zewex",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0f1115" },
    { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isTheme(saved) ? saved : undefined;
  return (
    <html lang="ru" className={inter.variable} data-theme={theme} suppressHydrationWarning>
      <head>
        <Script id="zx-theme-boot" strategy="beforeInteractive">{THEME_BOOT_SCRIPT}</Script>
      </head>
      <body>{children}</body>
    </html>
  );
}
