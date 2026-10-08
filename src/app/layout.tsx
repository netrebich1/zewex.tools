import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Self-hosted at build time: no runtime request to a third-party font CDN.
const inter = Inter({ subsets: ["latin", "cyrillic"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Zewex Tools", template: "%s · Zewex Tools" },
  description: "Внутренний портал инструментов Zewex",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = { themeColor: "#f6f5f2", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
