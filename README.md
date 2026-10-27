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
| 📱 | **App-style feed** | Watch **For You**, **Following**, **Explore**, and **Friends** in a vertical window with smooth scrolling, preloading, and GPU decoding. |
| ❤️ | **Interact** | Like, save to Favorites and collections, repost, follow, mark "Not interested", and report. |
| 💬 | **Comments** | Read comments and replies, like, reply, post, and see image comments — in a panel that never covers the whole screen. |
| ✉️ | **Messages** | Inbox with activity and new followers, chats with bubbles, quick reactions, older messages, and shared videos that open in the app. |
| 👤 | **Profiles** | Videos, reposts, favorites (with collections) and liked tabs; open hashtags, sounds, and @mentions. |
| 🔎 | **Search** | Videos and users, search history, and live suggestions. |
| ⬇️ | **Downloads** | MP4 without watermark, best quality, original with watermark, MP3 audio, and cover image — to a folder you choose. |
| 🎛️ | **Playback** | Speed, captions, picture-in-picture, auto-scroll, background play, and global media keys. |
| 🎨 | **Make it yours** | Dark, light, or system theme, accent colors, interface zoom, custom CSS themes, and fully customizable keyboard shortcuts. |
| 🪟 | **Desktop integration** | System tray, start with Windows, start minimized, close-to-tray, and remember window size. |
| 🌍 | **37 languages** | Follows your TikTok account language automatically; falls back to English. |
| 🔄 | **Auto-updates** | Checks GitHub Releases and installs new versions in one click. |

## 📥 Install

1. Download `Tokdesk.exe` from the [latest release](https://github.com/TheLucXas/tokdesk/releases/latest).
2. Run it. If the **.NET 8 Desktop Runtime** is missing, Tokdesk offers to download and install it from Microsoft automatically.
3. Sign in from **Profile** (QR code is the fastest way).

Requires Windows 10 or 11 with Microsoft Edge WebView2 (included in Windows 11).

## ⚙️ How it works

- A hidden instance of the official TikTok website runs with your own session and makes its own requests; Tokdesk renders the data in its own lightweight interface.
- Tokdesk does not forge request signatures or bypass verifications. If TikTok asks for a verification, you solve it on the official page.
- Your session, settings, and logs are stored in `%LOCALAPPDATA%\Tokdesk`.

## 🛠️ Build from source

Requirements: .NET 8 SDK.

```powershell
.\publish.ps1                         # builds dist\Tokdesk.exe and the zip
```

`.\publish.ps1 -Release -Notes "..."` additionally publishes a GitHub release with your own `gh` login, to the repository set in `Tokdesk\update.json`. It is meant for the maintainer; no tokens are included in this repository. If you fork Tokdesk, point `update.json` to your fork so your builds update from your own releases.

The published `Tokdesk.exe` is a small .NET Framework 4.8 launcher (built into Windows) that installs the .NET 8 runtime when needed and runs the embedded app.

## 🙏 Credits

- **Built with** [.NET 8 / WPF](https://github.com/dotnet/wpf) (MIT License) and the [Microsoft Edge WebView2 SDK](https://www.nuget.org/packages/Microsoft.Web.WebView2) (Microsoft license, redistributable). The WebView2 runtime and the .NET runtime are installed from Microsoft, not bundled.
- **Made with AI**: code, the Tokdesk icon, the interface icons (hand-drawn SVG), and the 37 translations were generated with Claude for this project. No third-party icon packs, fonts, or images are included; the UI uses the Windows system font.
- **Badges** by [shields.io](https://shields.io).

## ™️ Trademarks

TikTok is a trademark of ByteDance Ltd. WhatsApp and Facebook are trademarks of Meta Platforms, Inc.; Telegram of Telegram FZ-LLC; X of X Corp.; Windows, .NET, and Microsoft Edge of Microsoft Corporation. These names are used only to describe compatibility and share targets; their logos are not used. Tokdesk is not associated with any of these companies.

## 📄 License

Tokdesk's own code and assets are released into the public domain under [The Unlicense](LICENSE). Third-party components keep their own licenses.
