import { Outlet } from "react-router";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { AppSidebar } from "./components/app-sidebar";
import { Toaster } from "sonner";
import { useTranslation } from "react-i18next";
import { LogExplorerProvider } from "./contexts/log-explorer-context";
import cfLogo from "../../CF_logomark.svg";

export function AppLayout() {
  const { t } = useTranslation();

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
            <Outlet />
          </div>
        </SidebarInset>
        <img
          src={cfLogo}
          alt="Cloudflare"
          className="fixed top-3 right-4 z-50 h-5 w-auto opacity-80 pointer-events-none select-none"
        />
        <Toaster position="top-right" />
      </SidebarProvider>
    </LogExplorerProvider>
  );
}
