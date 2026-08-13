import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
});

export const metadata: Metadata = {
  title: "طابور القبول — جامعة الزقازيق الأهلية",
  description: "الشاشة العامة وصفحة استدعاء الأرقام لنظام طابور القبول بجامعة الزقازيق الأهلية.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ar" dir="rtl" className={`${cairo.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-[var(--font-cairo)]">{children}</body>
    </html>
  );
}
