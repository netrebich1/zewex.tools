import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client", "bcryptjs", "sharp", "@napi-rs/canvas", "undici", "fetch-socks", "socks"],
  // прогон до 3000 ссылок: список ссылок приходит в server action одним запросом
  experimental: { serverActions: { bodySizeLimit: "8mb" } },
  // undici подгружает llhttp-wasm через require по относительному пути — трассировка standalone его теряла
  // («Cannot find module '../llhttp/llhttp-wasm.js'» при проверке ключа DeepL через SOCKS-прокси).
  outputFileTracingIncludes: { "/**": ["./node_modules/undici/lib/llhttp/**", "./node_modules/fetch-socks/**", "./node_modules/socks/**"] },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
