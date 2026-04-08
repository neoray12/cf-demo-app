'use client';

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Bot,
  Globe,
  FileText,
  LogOut,
  Moon,
  Sun,
  ChevronUp,
  ChevronRight,
  ChevronDown,
  Camera,
  FileDown,
  ScanText,
  Image,
  Search,
  Braces,
  Link2,
  Globe2,
  Code,
  Languages,
  Database,
  Folder,
  FolderOpen,
  FileArchive,
  Loader2,
  RefreshCw,
  ArrowLeft,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTheme } from "@/hooks/use-theme";
import { useTranslation } from "react-i18next";
import { useLogExplorer, formatSize, type TreeNode } from "../contexts/log-explorer-context";

const crawlerSubItems = [
  { key: "screenshot", url: "/crawler/screenshot", icon: Camera },
  { key: "pdf", url: "/crawler/pdf", icon: FileDown },
  { key: "markdown", url: "/crawler/markdown", icon: ScanText },
  { key: "content", url: "/crawler/content", icon: Code },
  { key: "snapshot", url: "/crawler/snapshot", icon: Image },
  { key: "scrape", url: "/crawler/scrape", icon: Search },
  { key: "json", url: "/crawler/json", icon: Braces },
  { key: "links", url: "/crawler/links", icon: Link2 },
  { key: "crawl", url: "/crawler/crawl", icon: Globe2 },
];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { setOpenMobile, isMobile } = useSidebar();
  const { theme, toggleTheme } = useTheme();
  const { t, i18n } = useTranslation();
  const [currentUser, setCurrentUser] = useState<{ name: string; email: string } | null>(null);

  const isCrawlerActive = pathname.startsWith("/crawler");
  const isLogsActive = pathname === "/logs";

  const {
    buckets,
    loading,
    loadingPath,
    selectedFile,
    datasetMap,
    loadBuckets,
    toggleNode,
    selectFile,
  } = useLogExplorer();

  useEffect(() => {
    try {
      const raw = localStorage.getItem("cf-demo-user");
      if (raw) setCurrentUser(JSON.parse(raw));
    } catch {}
  }, []);

  // Load buckets when entering /logs
  useEffect(() => {
    if (isLogsActive && buckets.length === 0) {
      loadBuckets();
    }
  }, [isLogsActive, buckets.length, loadBuckets]);

  const handleNavClick = (url: string) => {
    router.push(url);
    if (isMobile) setOpenMobile(false);
  };

  const handleLogout = () => {
    localStorage.removeItem("cf-demo-auth");
    router.push("/login");
  };

  const toggleLanguage = () => {
    const nextLang = i18n.language === "zh-TW" ? "en" : "zh-TW";
    i18n.changeLanguage(nextLang);
  };

  const renderTree = (
    nodes: TreeNode[],
    depth: number = 0,
    parentPath: string[] = [],
    bucketName?: string
  ) => {
    return nodes.map((node) => {
      const currentPath = [...parentPath, node.name];
      const currentBucket = bucketName || node.name;
      const isLoading = loadingPath === node.fullPath;

      return (
        <div key={node.fullPath} style={{ paddingLeft: depth * 12 }}>
          <button
            className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-sidebar-accent transition-colors ${
              selectedFile?.key === node.fullPath
                ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                : "text-sidebar-foreground"
            }`}
            onClick={() => {
              if (node.type === "file") {
                selectFile(currentBucket, node.fullPath);
              } else {
                toggleNode(currentPath, currentBucket);
              }
            }}
          >
            {node.type === "file" ? (
              <div className="w-3.5" />
            ) : isLoading ? (
              <Loader2 className="size-3.5 animate-spin shrink-0" />
            ) : node.expanded ? (
              <ChevronDown className="size-3.5 shrink-0" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" />
            )}

            {node.type === "bucket" ? (
              <Database className="size-3.5 shrink-0 text-blue-500" />
            ) : node.type === "folder" ? (
              node.expanded ? (
                <FolderOpen className="size-3.5 shrink-0 text-yellow-500" />
              ) : (
                <Folder className="size-3.5 shrink-0 text-yellow-500" />
              )
            ) : node.name.endsWith(".gz") ? (
              <FileArchive className="size-3.5 shrink-0 text-orange-500" />
            ) : (
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            )}

            <span className="flex-1 text-left truncate min-w-0">
              <span className="block truncate" title={node.name}>{node.name}</span>
              {node.type === "bucket" && datasetMap[node.name] && (
                <span className="block truncate text-[10px] text-blue-500 dark:text-blue-400 font-normal" title={datasetMap[node.name]}>
                  {datasetMap[node.name]}
                </span>
              )}
            </span>

            {node.size !== undefined && (
              <span className="text-[10px] text-muted-foreground shrink-0">
                {formatSize(node.size)}
              </span>
            )}
          </button>

          {node.expanded && node.children && (
            <div>
              {renderTree(node.children, depth + 1, currentPath, currentBucket)}
              {node.children.length === 0 && node.loaded && (
                <div
                  className="px-2 py-1 text-[10px] text-muted-foreground"
                  style={{ paddingLeft: (depth + 1) * 12 + 8 }}
                >
                  {t("logs.empty")}
                </div>
              )}
            </div>
          )}
        </div>
      );
    });
  };

  // When on /logs, show dedicated log explorer sidebar content
  if (isLogsActive) {
    return (
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                onClick={() => handleNavClick("/")}
                tooltip={t("common.appName")}
              >
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-xs">
                  CF
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">{t("common.appName")}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {t("common.cloudflareWorkers")}
                  </span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {/* Back navigation */}
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => handleNavClick("/")}
                    tooltip={t("sidebar.backToHome")}
                    size="sm"
                  >
                    <ArrowLeft className="size-4" />
                    <span>{t("sidebar.backToHome")}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* R2 Buckets tree */}
          <SidebarGroup className="flex-1 min-h-0">
            <SidebarGroupLabel className="flex items-center justify-between">
              <span>{t("logs.r2Buckets")}</span>
              <button
                className="p-0.5 rounded hover:bg-sidebar-accent transition-colors"
                onClick={loadBuckets}
                disabled={loading}
              >
                <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
              </button>
            </SidebarGroupLabel>
            <SidebarGroupContent className="flex-1 min-h-0">
              <ScrollArea className="h-full">
                <div className="px-1 pb-2">
                  {loading && buckets.length === 0 ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    renderTree(buckets)
                  )}
                </div>
              </ScrollArea>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    size="lg"
                    className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  >
                    <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted">
                      <Bot className="size-4" />
                    </div>
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-semibold">{currentUser?.name ?? t("common.demoUser")}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {currentUser?.email ?? t("common.demoEmail")}
                      </span>
                    </div>
                    <ChevronUp className="ml-auto size-4" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                  side="bottom"
                  align="end"
                  sideOffset={4}
                >
                  <DropdownMenuItem onClick={toggleLanguage}>
                    <Languages className="size-4" />
                    <span>{i18n.language === "zh-TW" ? "English" : "繁體中文"}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleTheme}>
                    {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                    <span>{theme === "dark" ? t("sidebar.lightMode") : t("sidebar.darkMode")}</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleLogout} className="text-red-600">
                    <LogOut className="size-4" />
                    <span>{t("sidebar.logout")}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>

        <SidebarRail />
      </Sidebar>
    );
  }

  // Default sidebar for other routes
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={() => handleNavClick("/")}
              tooltip={t("common.appName")}
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-xs">
                CF
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{t("common.appName")}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {t("common.cloudflareWorkers")}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* AI Agent */}
        <SidebarGroup>
          <SidebarGroupLabel>{t("sidebar.features")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === "/"}
                  onClick={() => handleNavClick("/")}
                  tooltip={t("sidebar.aiAgent")}
                >
                  <Bot />
                  <span>{t("sidebar.aiAgent")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Crawler with sub-items */}
        <SidebarGroup>
          <SidebarGroupLabel>{t("sidebar.crawler")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <Collapsible defaultOpen={isCrawlerActive} className="group/collapsible">
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton
                      isActive={pathname === "/crawler"}
                      tooltip={t("sidebar.crawler")}
                      onClick={() => handleNavClick("/crawler")}
                    >
                      <Globe />
                      <span>{t("sidebar.overview")}</span>
                      <ChevronRight className="ml-auto size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenu className="ml-4 border-l pl-2">
                      {crawlerSubItems.map((item) => (
                        <SidebarMenuItem key={item.url}>
                          <SidebarMenuButton
                            isActive={pathname === item.url}
                            onClick={() => handleNavClick(item.url)}
                            tooltip={t(`crawler.endpoints.${item.key}.title`)}
                            size="sm"
                          >
                            <item.icon className="size-3.5" />
                            <span>{t(`crawler.endpoints.${item.key}.title`)}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </CollapsibleContent>
                </SidebarMenuItem>
              </Collapsible>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Log Explorer */}
        <SidebarGroup>
          <SidebarGroupLabel>{t("sidebar.tools")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={false}
                  onClick={() => handleNavClick("/logs")}
                  tooltip={t("sidebar.logExplorer")}
                >
                  <FileText />
                  <span>{t("sidebar.logExplorer")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-muted">
                    <Bot className="size-4" />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">{currentUser?.name ?? t("common.demoUser")}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {currentUser?.email ?? t("common.demoEmail")}
                    </span>
                  </div>
                  <ChevronUp className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                side="bottom"
                align="end"
                sideOffset={4}
              >
                <DropdownMenuItem onClick={toggleLanguage}>
                  <Languages className="size-4" />
                  <span>{i18n.language === "zh-TW" ? "English" : "繁體中文"}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={toggleTheme}>
                  {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  <span>{theme === "dark" ? t("sidebar.lightMode") : t("sidebar.darkMode")}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="text-red-600">
                  <LogOut className="size-4" />
                  <span>{t("sidebar.logout")}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
