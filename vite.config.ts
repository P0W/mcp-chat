import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { Readable } from "node:stream";

const APP_VERSION = process.env.npm_package_version ?? "0.0.0";
const BUILD_NUMBER =
  process.env.BUILD_NUMBER ?? process.env.GITHUB_RUN_NUMBER ?? "local";
const BUILD_TIME = new Date().toISOString();

// Dev-only proxy that lets the app reach MCP servers that don't allow browser
// origins. Usage: client prepends `/mcp-proxy/<full-target-url>` only when
// running on localhost. In the Capacitor APK requests go direct.
const mcpProxy: Plugin = {
  name: "mcp-proxy",
  configureServer(server) {
    server.middlewares.use("/mcp-proxy", async (req, res) => {
      try {
        const m = req.url?.match(/^\/(https?:\/\/[^/]+)(.*)$/);
        if (!m) {
          res.statusCode = 400;
          res.end("Bad proxy URL");
          return;
        }
        const target = m[1] + (m[2] || "/");
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!v) continue;
          const low = k.toLowerCase();
          if (["host", "connection", "content-length", "origin", "referer"].includes(low))
            continue;
          headers[k] = Array.isArray(v) ? v.join(", ") : v;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;

        const r = await fetch(target, {
          method: req.method,
          headers,
          body,
        });

        res.statusCode = r.status;
        r.headers.forEach((v, k) => {
          if (["transfer-encoding", "connection", "content-encoding"].includes(k.toLowerCase()))
            return;
          res.setHeader(k, v);
        });
        if (r.body) {
          Readable.fromWeb(r.body as never).pipe(res);
        } else {
          res.end();
        }
      } catch (e) {
        res.statusCode = 502;
        res.end("Proxy error: " + (e as Error).message);
      }
    });
  },
};

export default defineConfig({
  plugins: [react(), mcpProxy],
  server: { host: true, port: 5173 },
  build: { outDir: "dist", target: "es2020" },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_NUMBER__: JSON.stringify(BUILD_NUMBER),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
});
