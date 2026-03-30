import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import cfLogo from "../../../CF_logomark.svg";

export function LoginPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const isZh = i18n.language === "zh-TW" || i18n.language?.startsWith("zh");

  const toggleLanguage = () => {
    const next = isZh ? "en" : "zh-TW";
    i18n.changeLanguage(next);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    await new Promise((r) => setTimeout(r, 500));
    localStorage.setItem("cf-demo-auth", "true");
    setLoading(false);
    navigate("/");
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
            <img src={cfLogo} alt="Cloudflare" className="h-12 w-auto" />
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
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t("login.loggingIn") : t("login.loginButton")}
            </Button>
          </form>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            {t("login.demoHint")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
