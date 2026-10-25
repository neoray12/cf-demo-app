'use client';

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { AppSidebar } from "@/app/components/app-sidebar";
import { Toaster } from "sonner";
import { useTranslation } from "react-i18next";
import { LogExplorerProvider } from "@/app/contexts/log-explorer-context";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { t } = useTranslation();
  const [authed, setAuthed] = useState<boolean | null>(null);

  // The server decides who is signed in (Access JWT or the signed login cookie);
  // localStorage only caches the name/email the sidebar displays.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          localStorage.removeItem("cf-demo-auth");
          router.replace("/login");
          return;
        }
        const user = (await res.json()) as { name: string; email: string };
        localStorage.setItem("cf-demo-auth", "true");
        localStorage.setItem("cf-demo-user", JSON.stringify({ name: user.name, email: user.email }));
        setAuthed(true);
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Show nothing while checking auth
  if (authed === null) return null;

  return (
    <LogExplorerProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <span className="text-sm font-medium text-muted-foreground">
              {t("common.cloudflareDemo")}
            </span>
          </header>
          <div className="flex flex-1 flex-col overflow-hidden">
            {children}
          </div>
        </SidebarInset>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/CF_logomark.svg"
          alt="Cloudflare"
          className="fixed top-3 right-4 z-50 h-5 w-auto opacity-80 pointer-events-none select-none"
        />
        <Toaster position="top-right" />
      </SidebarProvider>
    </LogExplorerProvider>
  );
}
