<h1 align="center"><img src="assets/icon.png" width="44" alt="Tokdesk icon"> Tokdesk</h1>

<p align="center">
  <strong>A lightweight, unofficial desktop client for watching TikTok on Windows.</strong><br>
  Vertical app-style UI · GPU video playback · messages and comments · downloads · themes · 37 interface languages
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Unlicense" src="https://img.shields.io/badge/license-Unlicense-1684c2"></a>
  <img alt="Platform: Windows" src="https://img.shields.io/badge/platform-Windows-1684c2">
  <img alt="Runtime: .NET 8" src="https://img.shields.io/badge/runtime-.NET%208-0b997e">
  <img alt="Languages: 37" src="https://img.shields.io/badge/languages-37-0b997e">
  <img alt="Status: unofficial client" src="https://img.shields.io/badge/status-unofficial%20client-e09628">
  <img alt="Code: AI generated" src="https://img.shields.io/badge/code-AI%20generated-8d2ac2">
</p>

<p align="center">
  <a href="https://github.com/TheLucXas/tokdesk/releases/latest">Download</a> ·
  <a href="https://github.com/TheLucXas/tokdesk/discussions">Discussions</a> ·
  <a href="https://github.com/TheLucXas/tokdesk/issues">Report a bug</a>
</p>

---

> [!IMPORTANT]
> This is an unofficial community project, **vibe-coded**: the code, icons, and translations were generated with AI (Claude) and reviewed by a human. It may contain bugs and is not affiliated with, endorsed by, or sponsored by TikTok or ByteDance. You use your own TikTok account; Tokdesk does not include, host, or redistribute any TikTok content.

## ✨ What it does

| | Feature | What you can do |
| :---: | --- | --- |
| 📱 | **App-style feed** | Watch **For You**, **Following**, and **Friends** in a vertical window with smooth scrolling, preloading, and GPU decoding, with the app's page and sheet transitions. |
| 🧭 | **Explore** | A card grid like the app, with the 21 categories of TikTok Explore (Comedy, Sports, Anime, Food, Animals…). |
| 🔴 | **LIVE** | Watch LIVE streams inside Tokdesk with the app's LIVE screen: host, likes, viewers, live chat, emojis, sending messages and likes. A **LIVE** button opens recommended streams, followed accounts that are live appear above **Following**, and a ring marks anyone who is live right now. |
| 📖 | **Stories** | Profiles with active stories show a ring; tap the photo to watch them. |
| ❤️ | **Interact** | Like, save to Favorites and collections, repost, see who reposted, follow, block or unblock, mark "Not interested", and report videos or comments from a built-in menu. |
| 🌐 | **Translate** | "See translation" for video descriptions and comments, in your language. |
| 🧩 | **Related videos** | "Related videos" for any video, and the blue "Search: …" suggestion above comments. |
| 💬 | **Comments** | Read comments and replies, sort by popular or newest, like, reply, post, translate, and see image comments — in a panel that never covers the whole screen. |
| ✉️ | **Messages** | Inbox, chats with bubbles, emojis, quick reactions, older messages, shared videos and TikTok links that open in the app, and sending videos to several friends at once with a message. |
| 📣 | **Activity** | All activity or by group, as in the app: likes, comments, mentions, followers, and messages from TikTok. |
| 👤 | **Profiles** | Videos (latest, popular, or oldest first), playlists, followers and following, a "seen just now" marker, reposts, favorites (with collections and saved sounds) and liked tabs; edit your own profile; open hashtags, sounds, and @mentions. |
| 🎵 | **Sounds** | Sound pages with their videos, add sounds to Favorites, and listen to a preview from search. |
| 🔎 | **Search** | Top, Videos, Users, Sounds, and LIVE tabs, search history, live suggestions, and "You may like" based on what you watched. |
| ⬇️ | **Downloads** | MP4 without watermark, best quality, original with watermark, MP3 audio, and cover image — to a folder you choose. |
| 🎛️ | **Playback** | Speed, quality, captions, picture-in-picture, auto-scroll, background play, mute when unfocused, a seek bar with frame preview on hover, local history, and global media keys. |
| 🎞️ | **1080p and offline** | One-click install of Microsoft's free HEVC extension for 1080p, a disk buffer so videos start instantly, and offline videos (100 MB–2 GB) for when you have no internet. |
| 🔔 | **Notifications** | Windows notifications for likes, comments, mentions, followers, messages, and new Tokdesk versions, by category — even with the app closed, through a tiny helper (about 6 MB of RAM). |
| 🎨 | **Make it yours** | Dark, light, or system theme, accent colors, interface zoom, custom CSS themes, and fully customizable keyboard shortcuts. |
| 🪟 | **Desktop integration** | System tray, start with Windows, start minimized, close-to-tray, remember window size, and a maximized window that keeps an auto-hidden taskbar reachable. |
| 🔗 | **Open TikTok links** | Copy a TikTok link anywhere (for example "Copy link address" in your browser) and Tokdesk offers to open it when you switch to it, like the mobile app; internet shortcuts also open with **Send to → Tokdesk**. |
| 🌍 | **37 languages** | Follows your TikTok account language automatically; falls back to English. |
| 🔄 | **Auto-updates** | Checks GitHub Releases, installs new versions in one click, reopens the app, and shows what's new. |

## 📥 Install

1. Download `Tokdesk.exe` from the [latest release](https://github.com/TheLucXas/tokdesk/releases/latest).
2. Run it. If the **.NET 8 Desktop Runtime** is missing, Tokdesk offers to download and install it from Microsoft automatically.
3. Sign in from **Profile** (QR code is the fastest way).

Requires Windows 10 or 11 with Microsoft Edge WebView2 (included in Windows 11).

## ⚙️ How it works

- A hidden instance of the official TikTok website runs with your own session and makes its own requests; Tokdesk renders the data in its own lightweight interface.
- Tokdesk does not forge request signatures or bypass verifications. If TikTok asks for a verification, you solve it on the official page.
- Your session, settings, and logs are stored in `%LOCALAPPDATA%\Tokdesk`.
- With notifications enabled, a small helper (`Tokdesk.exe --notify`) checks your TikTok activity every few minutes with your session cookies, which Tokdesk stores encrypted by Windows (DPAPI) for your user only. Turn it off in **Settings → Notifications**.
- The HEVC button asks Microsoft's own Store delivery service for the free "HEVC Video Extensions from Device Manufacturer" package, downloads it from Microsoft's servers, and installs it for your user with `Add-AppxPackage` (Windows verifies Microsoft's signature).

## 🛠️ Build from source

Requirements: .NET 8 SDK.

```powershell
.\publish.ps1                         # builds dist\Tokdesk.exe and the zip
```

`.\publish.ps1 -Release -Notes "..."` additionally publishes a GitHub release with your own `gh` login, to the repository set in `Tokdesk\update.json`. It is meant for the maintainer; no tokens are included in this repository. If you fork Tokdesk, point `update.json` to your fork so your builds update from your own releases.

The published `Tokdesk.exe` is a small .NET Framework 4.8 launcher (built into Windows) that installs the .NET 8 runtime when needed and runs the embedded app.

## 🙏 Credits

- **Built with** [.NET 8 / WPF](https://github.com/dotnet/wpf) (MIT License) and the [Microsoft Edge WebView2 SDK](https://www.nuget.org/packages/Microsoft.Web.WebView2) (Microsoft license, redistributable). The WebView2 runtime and the .NET runtime are installed from Microsoft, not bundled.
- **LIVE playback:** [mpegts.js](https://github.com/xqq/mpegts.js) 1.8.0 (Apache License 2.0), bundled in `Tokdesk/web/vendor` with its license (`mpegts.LICENSE.txt`).
- **Symbol fallback fonts:** [Noto Sans Symbols, Symbols 2 and Math](https://fonts.google.com/noto) by Google (SIL Open Font License 1.1), loaded from Google Fonts only when a character is missing from the Windows fonts. The symbols subset of Noto Sans Symbols 2 is bundled in `Tokdesk/web/fonts` with its license (`OFL.txt`).
- **Made with AI**: code, the Tokdesk icon, the interface icons (hand-drawn SVG), and the 37 translations were generated with Claude for this project. No third-party icon packs or images are included (the LIVE, emoji, and block icons were also drawn from scratch); the UI uses the Windows system font, plus the Noto symbol fonts above for rare characters.
- **Badges** by [shields.io](https://shields.io).

## ™️ Trademarks

TikTok is a trademark of ByteDance Ltd. WhatsApp and Facebook are trademarks of Meta Platforms, Inc.; Telegram of Telegram FZ-LLC; X of X Corp.; Windows, .NET, and Microsoft Edge of Microsoft Corporation. These names are used only to describe compatibility and share targets; their logos are not used. Tokdesk is not associated with any of these companies.

## 📄 License

Tokdesk's own code and assets are released into the public domain under [The Unlicense](LICENSE). Third-party components keep their own licenses.
