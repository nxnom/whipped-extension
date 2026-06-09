# Whipped Extension

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/codkafoociihebdklkpfjjoacenkkhci?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/codkafoociihebdklkpfjjoacenkkhci)

A standalone Chrome/Chromium extension for capturing UI context off any web page and turning it into a ready-to-paste prompt for your AI coding agent.

**[Install from the Chrome Web Store →](https://chromewebstore.google.com/detail/codkafoociihebdklkpfjjoacenkkhci)**

## What it does

Click the toolbar icon to enter select mode, then click any element on the page. The extension captures:

- The **React component name** and **source file location** of the clicked element
- The surrounding DOM context

It then builds a **YAML prompt** you can paste directly into [Whipped](https://github.com/nxnom/whipped) or any AI coding agent. No server connection required — everything runs locally in the browser.

The toolbar icon is grayscale at rest and turns full color while select mode is active.

## Install

### From the Chrome Web Store (recommended)

[**Add to Chrome →**](https://chromewebstore.google.com/detail/codkafoociihebdklkpfjjoacenkkhci)

### From source (development)

1. Go to `chrome://extensions` in Chrome or any Chromium-based browser
2. Enable **Developer mode** (toggle in the top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder inside this repo

## Usage

1. Click the **Whipped** toolbar icon to activate select mode
2. Click any element on the page
3. Copy the generated YAML prompt from the popup
4. Paste it into your AI coding agent

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `background.js` | Service worker — manages icon state and mode toggling |
| `content.js` | Injected into pages (isolated world) — handles click interception |
| `content-main.js` | Injected into pages (main world) — reads React internals and source maps |
| `icons/` | Toolbar icons — color (active) and gray (inactive) variants |

## Permissions

- `activeTab` — access the current tab when the user clicks the toolbar icon
- `scripting` — inject content scripts to inspect the page
