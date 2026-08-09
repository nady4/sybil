import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkConfigured } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentsRE",
  description: "SRE-grade monitoring for AI agents — production + synthetic in one alert.",
};

function Nav() {
  return (
    <nav className="nav">
      <a href="/" className="brand">agentsre</a>
      <div className="links">
        <a href="/checks">checks</a>
        <a href="/runs">runs</a>
        <a href="/alerts">alerts</a>
        <a href="/billing">billing</a>
        <a href="/settings">settings</a>
      </div>
    </nav>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const content = (
    <html lang="en">
      <body>
        <Nav />
        <main className="main">{children}</main>
      </body>
    </html>
  );
  return clerkConfigured ? <ClerkProvider>{content}</ClerkProvider> : content;
}
