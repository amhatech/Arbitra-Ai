import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arbitra AI | Escrow & Compliance",
  description:
    "Verified freelance escrow, objective milestone compliance, and human-controlled release gates.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
