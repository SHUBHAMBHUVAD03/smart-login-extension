# 🔐 Smart Account Login Manager

A modern, privacy-first **Chrome / Edge extension (Manifest V3)** that stores your
accounts in an encrypted vault and logs you in with **one click** — including
smart handling of **Microsoft / Azure AD** and other multi-step login flows.

> Think of it as a lightweight, self-hosted password manager with an automatic
> "click → open site → type username → pick *Password* → type password → Sign in"
> workflow.

---

## 📖 Project Overview

- Click the toolbar icon → a modern popup shows all your accounts as cards.
- Click a card → the extension opens (or focuses) the website and signs you in.
- Everything is **encrypted with AES-256-GCM**; a **master password** is required
  to unlock the vault, and the vault **auto-locks** after inactivity.
- 100% local. **No servers, no telemetry, no external accounts.**

---

## ✨ Features

| Area | Details |
|------|---------|
| **One-click login** | Opens the site, fills username, clicks *Next*, selects *Password* when multiple methods are offered, fills password, clicks *Sign in*, handles *Stay signed in?* |
| **Microsoft-aware** | Understands `login.microsoftonline.com` / `login.live.com` field IDs (`#i0116`, `#i0118`, `#idSIButton9`) and the credential-method picker |
| **Modern UI** | Dashboard with cards, website icons, smooth animations |
| **Dark & Light mode** | One-tap theme toggle, remembered across sessions |
| **Search & filter** | Live search + category chips |
| **Favorites & Recent** | Dedicated sections for starred and recently used accounts |
| **Full account management** | Add · Edit · Delete · Favorite · Categorize |
| **Security** | Web Crypto API, PBKDF2 (250k iterations), AES-GCM, master password, auto-lock, passwords never shown in plain text |
| **Backup** | Export / import the **encrypted** vault |

---

## 🚀 Installation Steps

> The extension is unpacked (developer) — no store listing required.

1. **Download / clone** this folder so you have `smart-login-extension/` locally.
2. Open your browser's extensions page:
   - **Chrome:** `chrome://extensions`
   - **Edge:** `edge://extensions`
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the **`smart-login-extension/`** folder (the one containing `manifest.json`).
6. Pin the extension: click the puzzle-piece icon → pin **Smart Account Login Manager**.
7. Click the icon → **create your master password** → start adding accounts.

*(Icons are pre-generated in `assets/icons/`. If you replace them, keep the same
filenames: `icon16/32/48/128.png`.)*

---

## 📁 Folder Structure

```
smart-login-extension/
│
├── manifest.json              # MV3 configuration
│
├── popup/                     # The dashboard shown when you click the icon
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
│
├── options/                   # Settings page (theme, auto-lock, master pw, backup)
│   ├── options.html
│   ├── options.css
│   └── options.js
│
├── background/
│   └── background.js          # MV3 service worker: session/auto-lock + login orchestration
│
├── content/
│   └── content.js             # Auto-fill state machine injected into login pages
│
├── utils/
│   ├── crypto.js              # Web Crypto: PBKDF2 key derivation + AES-GCM encrypt/decrypt
│   └── storage.js             # Encrypted JSON vault + account CRUD
│
├── styles/
│   └── theme.css              # Shared design tokens (dark/light) + base components
│
├── storage/
│   └── sample-accounts.json   # Reference only — shows the account shape
│
├── assets/
│   └── icons/                 # icon16.png / icon32.png / icon48.png / icon128.png
│
└── README.md
```

---

## ⚙️ Configuration Guide

Open **Settings** from the extension details page (or right-click the icon →
*Options*). You can:

- **Theme** — Dark / Light (also toggled from the popup header 🌙 / ☀️).
- **Auto-lock** — lock the vault after 1 / 5 / 15 / 30 / 60 minutes of inactivity.
- **Change master password** — re-encrypts every stored secret under the new key.
- **Backup & Restore** — export/import the encrypted vault as JSON.
- **Danger zone** — erase the vault entirely.

---

## 🔑 Where to Add Usernames and Passwords

This is the most important section — read it fully.

### 1. How users add accounts
1. Click the extension icon to open the popup.
2. On first run, **create a master password** (minimum 8 characters).
   > ⚠️ This password is **never stored** and **cannot be recovered**. If you
   > forget it, your vault cannot be decrypted. Keep a safe backup of it.
3. Click the **`＋` (Add)** button in the top bar.
4. Fill in the form:
   - **Account Name** – e.g. `Cognizant Project Account`
   - **Website URL** – the login page, e.g. `https://login.microsoftonline.com`
   - **Username / Email** – e.g. `example@company.com`
   - **Password** – your account password
   - **Category** – e.g. `Work`, `Personal` (used for filtering)
   - **Favorite** – optional ⭐
   - **Description / Usage** – e.g. `Used for Cognizant project work.`
5. Click **Save**. The card appears on your dashboard immediately.

### 2. Where credentials are stored
- Credentials live **only on your machine**, inside the browser's
  `chrome.storage.local` under a single `vault` object.
- **Username and password are encrypted** (AES-256-GCM) before being written.
  Everything else (name, URL, category) is metadata used for search/display.
- The **derived encryption key** is kept only in memory / `chrome.storage.session`
  while the vault is unlocked, and is cleared on lock or auto-lock.
- Nothing is ever sent to any server. There is no cloud sync.

### 3. How encryption works
```
Master password ──PBKDF2 (SHA-256, 250,000 iterations, random 16-byte salt)──▶ AES-256 key
                                                                                    │
Each secret (username / password) ──AES-GCM (fresh 12-byte IV per value)───────────┘──▶ { iv, data } (base64)
```
- A **verifier** token (`SALM_VERIFY_v1`) is encrypted at setup. On unlock the
  entered password must decrypt it correctly — that's how we validate the master
  password **without ever storing it**.
- See [`utils/crypto.js`](utils/crypto.js) and [`utils/storage.js`](utils/storage.js).

### 4. How to update account information
1. On a card, click the **`✎` (Edit)** button.
2. Change any field. **Leave the password field blank to keep the existing password**;
   type a new value to replace it.
3. Click **Save**.

### 5. How to remove accounts
1. Click **`✎` (Edit)** on the card.
2. Click **Delete** (bottom-left of the dialog) and confirm.
   *(Deletion is permanent.)*

---

## 🤖 How the One-Click Login Works

When you click an account card:

1. **Open / focus** the account's website (reuses an existing tab on the same origin).
2. Wait for the page to finish loading, then inject the content script.
3. **Type the username / email** into the detected field.
4. **Click *Next*** (`#idSIButton9`, or a *Next* / *Continue* button).
5. If several sign-in methods are shown (**Password**, Authenticator, Security key,
   OTP, …), the extension **selects *Password*** automatically.
6. Wait for the password screen, **type the password**.
7. **Click *Sign in* / *Login***.
8. Handle Microsoft's **"Stay signed in?"** prompt.

Works with generic single-page forms too (username + password on one screen).

---

## 🖼️ Screenshots

_Add your own screenshots here:_

| Unlock | Dashboard (dark) | Add / Edit |
|--------|------------------|------------|
| ![Unlock screen](assets/screenshots/unlock.png) | ![Dashboard](assets/screenshots/dashboard.png) | ![Add account](assets/screenshots/add.png) |

> Create an `assets/screenshots/` folder and drop `unlock.png`, `dashboard.png`,
> and `add.png` in it to populate the table above.

---

## 🧯 Troubleshooting

| Problem | Fix |
|---------|-----|
| **"Invalid master password"** | Re-check the password. There is no recovery — if forgotten, use *Settings → Danger zone* to reset and re-add accounts. |
| **Login didn't auto-fill** | Some sites use unusual field names or heavy anti-bot protection. Open the site once, then retry. You can also copy the password with the `⧉` button and paste manually. |
| **Wrong sign-in method selected** | The site may label its "Password" option differently. Fall back to copying the password (`⧉`) and finishing manually. |
| **Nothing happens on click** | Ensure the account has a valid `https://` URL, and that the extension has host permissions (it requests `<all_urls>`). |
| **Vault locked too quickly** | Increase the timer in *Settings → Auto-lock*. |
| **Icons don't show on cards** | Cards use the site's `/favicon.ico`; if it's missing, a colored initial is shown instead. This is normal. |
| **Changes not saving** | Make sure the vault is unlocked (you should see the dashboard, not the lock screen). |

---

## 🔒 Security Notes & Limitations

- Encryption uses the browser's **Web Crypto API** (AES-256-GCM + PBKDF2). Secrets
  are never persisted in plain text and are never transmitted anywhere.
- While the vault is **unlocked**, the derived key sits in `chrome.storage.session`
  so the popup can decrypt on demand; it is wiped on lock / auto-lock / browser close.
- Auto-fill requires broad host permissions (`<all_urls>`) so it can act on whichever
  login page you choose. Review the code in [`content/content.js`](content/content.js)
  if you want to narrow this.
- This is a personal productivity tool. For high-security or shared environments,
  prefer an audited, dedicated password manager.

---

## 🛠️ Tech Stack

- **Manifest V3** service worker + programmatic script injection (`chrome.scripting`)
- **Vanilla JS (ES modules)** — no build step, no dependencies
- **Web Crypto API** for all cryptography
- **chrome.storage.local** (encrypted vault) + **chrome.storage.session** (session key)
- **chrome.alarms** for auto-lock

---

## 📄 License

Provided as-is for educational and personal use. Review and adapt before any
production or organizational deployment.
"# smart-login-extension" 
