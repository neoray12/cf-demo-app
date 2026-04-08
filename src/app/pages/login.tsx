'use client';

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

const DEMO_USERS = [
  { username: 'neo', name: 'Neo', email: 'neo@cloudflare.com' },
  { username: 'vera', name: 'Vera', email: 'vera@cloudflare.com' },
  { username: 'menghsien', name: 'Kevin', email: 'menghsien@cloudflare.com' },
  { username: 'demo', name: 'Demo', email: 'demo@cloudflare.com' },
];

export function LoginPage() {
  const router = useRouter();
  const { t } = useTranslation();
  const [username, setUsername] = useState("neo");
  const [password, setPassword] = useState("neo");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileReady, setTurnstileReady] = useState(false);
  const isZh = i18n.language === "zh-TW" || i18n.language?.startsWith("zh");

  useEffect(() => {
    (window as any).onTurnstileSuccess = (token: string) => {
      setTurnstileToken(token);
      setTurnstileReady(true);
    };
    (window as any).onTurnstileExpired = () => setTurnstileToken("");
    (window as any).onTurnstileError = () => setTurnstileReady(true);
    const timer = setTimeout(() => setTurnstileReady(true), 6000);
    return () => {
      clearTimeout(timer);
      delete (window as any).onTurnstileSuccess;
      delete (window as any).onTurnstileExpired;
      delete (window as any).onTurnstileError;
    };
  }, []);

  const toggleLanguage = () => {
    const next = isZh ? "en" : "zh-TW";
    i18n.changeLanguage(next);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!turnstileToken) {
      setError("請完成人機驗證");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, turnstileToken }),
      });
      const data = await res.json() as { name?: string; email?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? "登入失敗");
        if ((window as any).turnstile) (window as any).turnstile.reset();
        setTurnstileToken("");
        return;
      }
      localStorage.setItem("cf-demo-auth", "true");
      localStorage.setItem("cf-demo-user", JSON.stringify({ name: data.name, email: data.email }));
      router.push("/");
    } catch {
      setError("登入失敗，請稍後再試");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-muted p-4">
      {/* Language Toggle - top right */}
      <button
        type="button"
        onClick={toggleLanguage}
        className="absolute right-4 top-4 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        {isZh ? "English" : "中文"}
      </button>

      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-4">
          {/* Cloudflare Logo */}
          <div className="mx-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/CF_logomark.svg" alt="Cloudflare" className="h-12 w-auto" />
          </div>
          <div>
            <CardTitle className="text-2xl">{t("login.title")}</CardTitle>
            <CardDescription className="mt-1">
              {t("login.description")}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="username">
                {t("login.username")}
              </label>
              <Input
                id="username"
                placeholder={t("login.usernamePlaceholder")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="password">
                {t("login.password")}
              </label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder={t("login.passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {/* Turnstile widget */}
            <div className="flex justify-center">
              <div
                className="cf-turnstile"
                data-sitekey="0x4AAAAAAC2QlDdiFqByHU1Z"
                data-callback="onTurnstileSuccess"
                data-expired-callback="onTurnstileExpired"
                data-error-callback="onTurnstileError"
                data-theme="auto"
              />
            </div>

            {error && (
              <p className="text-sm text-destructive text-center">{error}</p>
            )}

            <Button type="submit" className="w-full" disabled={loading || !turnstileReady}>
              {loading ? t("login.loggingIn") : t("login.loginButton")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
