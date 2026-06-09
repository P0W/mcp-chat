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
- **Session SQLite**: optional in-memory SQLite tools let chats import MCP
  output or local markdown/CSV/text/JSON file contents, run joins, groups,
  sorts, and other SQL locally, then drop or export the database when done.
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
- CI sets a monotonically increasing `versionCode` for each run attempt so APK
  updates can be installed in-place.
- For local APK updates, set a higher version code explicitly, e.g.
  `cd android && ./gradlew -PappVersionCode=2 -PappVersionName=1.0.1 assembleDebug`.

### Troubleshooting: "App not installed" / "something went wrong"

If the installer shows an **Update** button but then fails with *App not
installed*, the new APK and the installed app disagree on one of the three
requirements above. The two common causes:

- **Signature mismatch.** The copy you already have was signed with a
  different key (for example an APK built locally with Android Studio's
  auto-generated `~/.android/debug.keystore`, or an old build made before the
  stable `android/debug.keystore` existed). Android never lets one key
  overwrite an app signed by another. **Fix:** uninstall the existing MCP Chat
  once, then install the new APK. This is a one-time step; every build signed
  with the committed `android/debug.keystore` updates in-place afterwards.
  Note that uninstalling clears the app's on-device data (chats, keys, MCP
  configs), since everything lives in the app's storage.
- **Downgrade.** The APK you are installing has a lower (or equal)
  `versionCode` than the one already installed — for example downloading an
  older CI run's artifact. **Fix:** install an APK from a newer build, or
  uninstall first.

Also make sure you are installing the `.apk` itself. GitHub Actions delivers
the build artifact as a `.zip`; unzip it and install the `.apk` inside, or
download the APK attached to a GitHub Release.

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
  sessionSqlTools.ts optional in-memory SQLite data tools
  App.tsx         tab router
  main.tsx        React entry
  index.css       Tailwind + small markdown styles
  ui/
    Chat.tsx
    Providers.tsx
    McpServers.tsx
    Markdown.tsx
```
