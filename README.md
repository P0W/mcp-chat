# MCP Chat

A minimal, mobile-friendly chat app that talks to any LLM and any
Streamable-HTTP MCP server. Built with Vite + React + TypeScript + Tailwind,
bundled for Android via Capacitor.

Designed for Pixel 10a but should work on any Android 7+ device.

## Features

- **Provider-agnostic**: any OpenAI-compatible or Anthropic-style endpoint.
  Built-in presets for Claude, OpenAI, Gemini, DeepSeek, Kimi K2, OpenRouter.
  Add your own.
- **MCP-native**: connect any Streamable HTTP MCP server. Three auth modes:
  none, bearer token, or OAuth 2.1 (auto-discovery, dynamic client
  registration, PKCE).
- **Tools loop**: the assistant sees and can call all enabled MCP tools.
- **On-device only**: provider keys, MCP configs, and chats live in IndexedDB
  on your phone. Nothing is sent anywhere except the LLM and MCP servers you
  configured.

## Develop

```bash
npm install
npm run dev          # browser preview at http://localhost:5173
```

## Build Android APK

```bash
npm run build
npx cap add android  # first time only
npm run android      # opens Android Studio with the synced project
```

In Android Studio: Build > Build Bundle(s) / APK(s) > Build APK(s).

### APK update behavior

- Android only installs an APK update when the new APK has:
  - the same application ID,
  - the same signing key,
  - and a higher `versionCode`.
- This repo expects a stable debug signing key at
  `android/debug.keystore` (alias/password: `androiddebugkey`/`android`).
- CI sets a monotonically increasing `versionCode` for each run so APK
  updates can be installed in-place.

### OAuth deep link

The app uses `mcpchat://oauth-callback` for OAuth redirects. After
`npx cap add android`, add this intent filter inside the main activity in
`android/app/src/main/AndroidManifest.xml`:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="mcpchat" android:host="oauth-callback" />
</intent-filter>
```

## File map

```
src/
  types.ts        TS types
  db.ts           IndexedDB (providers, mcps, chats)
  llm.ts          provider-agnostic LLM with tool-call loop
  mcp.ts          Streamable HTTP MCP client + OAuth (PKCE + DCR)
  App.tsx         tab router
  main.tsx        React entry
  index.css       Tailwind + small markdown styles
  ui/
    Chat.tsx
    Providers.tsx
    McpServers.tsx
    Markdown.tsx
```
