import { createBrowserRouter, Navigate } from "react-router";
import { AppLayout } from "./layout";
import { LoginPage } from "./pages/login";
import { ChatPage } from "./pages/chat";
import { CrawlerPage } from "./pages/crawler";
import { CrawlerEndpointPage } from "./pages/crawler-endpoint";
import { LogExplorerPage } from "./pages/log-explorer";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const isAuth = localStorage.getItem("cf-demo-auth") === "true";
  if (!isAuth) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/",
    element: (
      <AuthGuard>
        <AppLayout />
      </AuthGuard>
    ),
    children: [
      { index: true, element: <ChatPage /> },
      { path: "crawler", element: <CrawlerPage /> },
      { path: "crawler/:endpoint", element: <CrawlerEndpointPage /> },
      { path: "logs", element: <LogExplorerPage /> },
    ],
  },
]);
