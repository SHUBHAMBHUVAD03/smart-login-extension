/**
 * options/options.js — settings, master-password change, backup/restore, wipe.
 */

import { exportKey, importKey } from "../utils/crypto.js";
import * as store from "../utils/storage.js";

const SESSION_KEY = "sessionKey";
const $ = (s) => document.querySelector(s);

let key = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const settings = await store.getSettings();
  document.documentElement.setAttribute("data-theme", settings.theme);

  if (!(await store.isInitialized())) {
    // Nothing to configure until the vault exists (created from the popup).
    $("#locked-card").classList.remove("hidden");
    $("#locked-card").querySelector("h2").textContent = "No vault yet";
    $("#locked-card").querySelector(".muted").textContent =
      "Open the extension popup and create a master password first.";
    $("#unlock-form").classList.add("hidden");
    return;
  }

  const { [SESSION_KEY]: cached } = await chrome.storage.session.get(SESSION_KEY);
  if (cached) {
    try {
      key = await importKey(cached);
      await enterSettings();
      return;
    } catch {
      /* fall through to unlock */
    }
  }
  $("#locked-card").classList.remove("hidden");
  wireUnlock();
}

function wireUnlock() {
  $("#unlock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#unlock-error");
    err.textContent = "";
    try {
      key = await store.unlock($("#unlock-pass").value);
      const exported = await exportKey(key);
      const settings = await store.getSettings();
      await chrome.runtime.sendMessage({
        type: "SET_SESSION",
        exportedKey: exported,
        minutes: settings.autoLockMinutes,
      });
      await enterSettings();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
}

async function enterSettings() {
  $("#locked-card").classList.add("hidden");
  $("#settings-area").classList.remove("hidden");

  const settings = await store.getSettings();
  $("#theme-select").value = settings.theme;
  $("#autolock-select").value = String(settings.autoLockMinutes);

  $("#theme-select").addEventListener("change", async (e) => {
    await store.updateSettings({ theme: e.target.value });
    document.documentElement.setAttribute("data-theme", e.target.value);
  });

  $("#autolock-select").addEventListener("change", async (e) => {
    const minutes = Number(e.target.value);
    await store.updateSettings({ autoLockMinutes: minutes });
    chrome.runtime.sendMessage({ type: "ACTIVITY", minutes });
  });

  $("#change-pw-form").addEventListener("submit", changePassword);
  $("#export-btn").addEventListener("click", exportVault);
  $("#import-file").addEventListener("change", importVault);
  $("#wipe-btn").addEventListener("click", wipe);
}

async function changePassword(e) {
  e.preventDefault();
  const err = $("#pw-error");
  err.classList.remove("ok");
  err.textContent = "";

  const cur = $("#cur-pw").value;
  const p1 = $("#new-pw").value;
  const p2 = $("#new-pw2").value;

  if (p1.length < 8) return (err.textContent = "New password must be at least 8 characters.");
  if (p1 !== p2) return (err.textContent = "New passwords do not match.");

  try {
    await store.unlock(cur); // verify current password
    key = await store.changeMasterPassword(key, p1);
    const exported = await exportKey(key);
    const settings = await store.getSettings();
    await chrome.runtime.sendMessage({
      type: "SET_SESSION",
      exportedKey: exported,
      minutes: settings.autoLockMinutes,
    });
    e.target.reset();
    err.classList.add("ok");
    err.textContent = "Master password updated.";
  } catch (ex) {
    err.textContent = ex.message || "Could not change password.";
  }
}

async function exportVault() {
  const json = await store.exportVault();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "smart-login-vault.json";
  a.click();
  URL.revokeObjectURL(url);
  msg("Encrypted vault exported.", true);
}

async function importVault(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    await store.importVault(text);
    msg("Vault imported. Unlock with its master password.", true);
    setTimeout(() => location.reload(), 1200);
  } catch (ex) {
    msg(ex.message || "Import failed.", false);
  }
}

async function wipe() {
  if (!confirm("Erase the entire vault and all accounts? This cannot be undone.")) return;
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await chrome.runtime.sendMessage({ type: "LOCK" });
  msg("Vault erased.", true);
  setTimeout(() => location.reload(), 1000);
}

function msg(text, ok) {
  const el = $("#backup-msg");
  el.textContent = text;
  el.classList.toggle("ok", !!ok);
}
