import "@/styles/globals.css";
import { Providers } from "./providers";

export const metadata = {
  title: "CF Demo App",
  description: "Cloudflare Demo Application",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW" suppressHydrationWarning>
      <body className="min-h-screen bg-background antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
