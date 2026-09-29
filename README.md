# MCP Chat

Author: Prashant Srivastava

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
- **File attachments**: attach images and documents from the device (paperclip
  button or drag and drop) and preview them before sending. See
  [Attachments](#attachments).
- **On-device only**: provider keys, MCP configs, and chats live in IndexedDB
  on your phone. Nothing is sent anywhere except the LLM and MCP servers you
  configured.

## Develop

```bash
npm install
npm run dev          # browser preview at http://localhost:5173
npm test             # vitest unit tests
npm run build        # typecheck + production build
```

## Attachments

Use the paperclip button next to the message box (or drop files on the
composer) to attach files. Each file is checked, parsed on the device, and
shown in a tray above the input with a thumbnail or icon, its type and size,
and a remove button. Send stays disabled while files are being processed.

**Supported formats**

| Kind      | Extensions                                   | Sent as                                   |
| --------- | -------------------------------------------- | ----------------------------------------- |
| Images    | .jpg .jpeg .png .gif .webp .bmp              | image input (vision models)               |
| SVG       | .svg                                         | markup as text, never rendered            |
| PDF       | .pdf                                         | native PDF input or extracted text        |
| Office    | .docx .pptx .xlsx                            | extracted text (slides and sheets headed) |
| Text      | .txt .md .csv                                | text                                      |

Every file must have a supported extension. The declared MIME type must agree
with it, and the file contents must pass a signature check (magic bytes, zip
layout for Office files, UTF-8 for text). Files that fail are rejected with a
message saying why. Legacy `.doc`, `.xls`, and `.ppt` files are not supported.

**Limits** (defaults; override at build time with env vars)

| Limit                     | Default     | Env var                          |
| ------------------------- | ----------- | -------------------------------- |
| Size per file             | 10 MB       | `VITE_ATTACHMENT_MAX_FILE_MB`    |
| Files per message         | 5           | `VITE_ATTACHMENT_MAX_FILES`      |
| Total size per message    | 20 MB       | `VITE_ATTACHMENT_MAX_TOTAL_MB`   |
| Extracted text per file   | 100k chars  | `VITE_ATTACHMENT_MAX_TEXT_CHARS` |

Images larger than 2048 px are scaled down, and images still larger than
3.75 MB are re-encoded as JPEG so they fit provider limits. BMP is converted to
PNG. Office archives are capped at 50 MB uncompressed to guard against zip
bombs. Longer extracted text is truncated and the model is told.

**Provider support**

Each provider has an **Attachments** setting (Providers tab):

- `auto` (default) guesses from the provider and model. Claude gets images and
  native PDFs. OpenAI (api.openai.com) gets images and PDFs when the model looks
  vision-capable. OpenRouter gets images and PDFs. Gemini gets images, with PDFs
  sent as text. Other OpenAI-compatible endpoints get images only when the model
  name looks vision-capable. Models that look text-only (for example
  `deepseek-chat`, `o1-mini`) get text only.
- `text`, `images`, `images+pdf` force a mode when the guess is wrong.

When a model can't take a file natively, the app falls back gracefully:
PDFs are sent as extracted text, and images are replaced by a short note
telling the model an image was attached but can't be shown. The tray shows
how each file will be sent. Scanned PDFs without a text layer only work with
native PDF input. Excel dates are sent as serial numbers.

**Architecture**

There is no app server. Files are read in the WebView and sent straight to your
configured provider as part of the chat request, then kept with the chat in
on-device IndexedDB. Nothing is uploaded anywhere else. The limits are checked
twice: when files are added, and again when the request is built
(`buildUserParts`), so oversized payloads never leave the device.

```
src/attachments/
  types.ts         attachment, limit, and capability types
  limits.ts        default limits + env overrides
  formats.ts       format registry (extensions, MIME types, signatures)
  validate.ts      filename sanitizing, MIME/extension/content checks
  encoding.ts      base64 and strict UTF-8 decoding
  ooxml.ts         bounded unzip + docx/pptx/xlsx text extraction
  pdf.ts           lazy-loaded pdf.js text extraction
  image.ts         decode check, resize, BMP to PNG
  process.ts       File -> ChatAttachment pipeline
  capabilities.ts  per-provider/model attachment support
  transport.ts     OpenAI / Anthropic content-part serialization
  queue.ts         composer attachment state (framework free)
  useAttachmentQueue.ts  React binding
src/ui/Attachments.tsx   attach button, drop zone, tray, message chips
```

Security notes: filenames are sanitized before display or sending, SVGs are
never rendered, previews use object URLs that are revoked on removal or send,
file contents are never logged, and pdf.js runs with eval and font loading
turned off.

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
  attachments/    file attachment validation, parsing, serialization
  App.tsx         tab router
  main.tsx        React entry
  index.css       Tailwind + small markdown styles
  ui/
    Chat.tsx
    Attachments.tsx attach button, drop zone, attachment tray
    Providers.tsx
    McpServers.tsx
    Markdown.tsx
```
