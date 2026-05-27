import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.prashants.mcpchat",
  appName: "MCP Chat",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
  },
  plugins: {
    // Patches window.fetch to route through the native Android HTTP stack,
    // bypassing WebView CORS for MCP servers (Zerodha Kite et al) that
    // refuse browser origins.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
