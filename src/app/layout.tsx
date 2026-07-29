import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "60-Second Lead Agent",
  description:
    "An AI agent that texts every lead back in 60 seconds, on whatever app they actually use. Built on Sent.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
