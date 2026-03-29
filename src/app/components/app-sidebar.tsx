import { useLocation, useNavigate } from "react-router";
import {
  Bot,
  Globe,
  FileText,
  LogOut,
  Moon,
  Sun,
  ChevronUp,
  ChevronRight,
  Camera,
  FileDown,
  ScanText,
  Image,
  Search,
  Braces,
  Link2,
  Globe2,
  Code,
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
import { useTheme } from "@/hooks/use-theme";

const crawlerSubItems = [
  { title: "截圖", url: "/crawler/screenshot", icon: Camera },
  { title: "PDF 轉換", url: "/crawler/pdf", icon: FileDown },
  { title: "Markdown 擷取", url: "/crawler/markdown", icon: ScanText },
  { title: "HTML 內容", url: "/crawler/content", icon: Code },
  { title: "快照", url: "/crawler/snapshot", icon: Image },
  { title: "元素提取", url: "/crawler/scrape", icon: Search },
  { title: "JSON 結構化", url: "/crawler/json", icon: Braces },
  { title: "連結抓取", url: "/crawler/links", icon: Link2 },
  { title: "整站爬取", url: "/crawler/crawl", icon: Globe2 },
];

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { setOpenMobile, isMobile } = useSidebar();
  const { theme, toggleTheme } = useTheme();

  const isCrawlerActive = location.pathname.startsWith("/crawler");

  const handleNavClick = (url: string) => {
    navigate(url);
    if (isMobile) setOpenMobile(false);
  };

  const handleLogout = () => {
    localStorage.removeItem("cf-demo-auth");
    navigate("/login");
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              onClick={() => handleNavClick("/")}
              tooltip="CF Demo"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-xs">
                CF
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">CF Demo</span>
                <span className="truncate text-xs text-muted-foreground">
                  Cloudflare Workers
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* AI Agent */}
        <SidebarGroup>
          <SidebarGroupLabel>功能</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={location.pathname === "/"}
                  onClick={() => handleNavClick("/")}
                  tooltip="AI Agent"
                >
                  <Bot />
                  <span>AI Agent</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* 網站爬蟲 with sub-items */}
        <SidebarGroup>
          <SidebarGroupLabel>網站爬蟲</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <Collapsible defaultOpen={isCrawlerActive} className="group/collapsible">
                <SidebarMenuItem>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton
                      isActive={location.pathname === "/crawler"}
                      tooltip="網站爬蟲"
                    >
                      <Globe />
                      <span>總覽</span>
                      <ChevronRight className="ml-auto size-4 transition-transform group-data-[state=open]/collapsible:rotate-90" />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenu className="ml-4 border-l pl-2">
                      {crawlerSubItems.map((item) => (
                        <SidebarMenuItem key={item.url}>
                          <SidebarMenuButton
                            isActive={location.pathname === item.url}
                            onClick={() => handleNavClick(item.url)}
                            tooltip={item.title}
                            size="sm"
                          >
                            <item.icon className="size-3.5" />
                            <span>{item.title}</span>
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

        {/* Log 瀏覽器 */}
        <SidebarGroup>
          <SidebarGroupLabel>工具</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={location.pathname === "/logs"}
                  onClick={() => handleNavClick("/logs")}
                  tooltip="Log 瀏覽器"
                >
                  <FileText />
                  <span>Log 瀏覽器</span>
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
                    <span className="truncate font-semibold">Demo User</span>
                    <span className="truncate text-xs text-muted-foreground">
                      demo@cloudflare.com
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
                <DropdownMenuItem onClick={toggleTheme}>
                  {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  <span>{theme === "dark" ? "淺色模式" : "深色模式"}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="text-red-600">
                  <LogOut className="size-4" />
                  <span>登出</span>
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
