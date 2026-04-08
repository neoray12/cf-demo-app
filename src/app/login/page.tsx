'use client';

import Script from 'next/script';
import { LoginPage } from "@/app/pages/login";

export default function LoginRoute() {
  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        strategy="afterInteractive"
      />
      <LoginPage />
    </>
  );
}
