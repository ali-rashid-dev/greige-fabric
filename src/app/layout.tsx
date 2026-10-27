import type { Metadata } from "next";
import "./globals.css";

const isDevelopment = process.env.NODE_ENV === "development";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  `connect-src 'self'${isDevelopment ? " http://127.0.0.1:3000 ws://127.0.0.1:3000" : ""}`,
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const metadata: Metadata = {
  title: "Greige Fabric POS",
  description: "Point-of-sale workspace for Greige Fabric.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta
          httpEquiv="Content-Security-Policy"
          content={contentSecurityPolicy}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
