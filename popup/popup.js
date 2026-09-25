/**
 * popup/popup.js
 * -----------------------------------------------------------------------------
 * Controller for the popup dashboard: unlock/setup, rendering account cards,
 * search/filter, CRUD via a modal, and triggering the one-click login.
 * -----------------------------------------------------------------------------
 */

import { exportKey, importKey, decrypt } from "../utils/crypto.js";
import * as store from "../utils/storage.js";

const SESSION_KEY = "sessionKey";
const PRESET_CATEGORIES = ["Work", "Personal", "Finance", "Social", "Dev", "Other"];

const state = {
  key: null,
  settings: { autoLockMinutes: 5, theme: "dark" },
  accounts: [], // decrypted-username view models
  filter: { search: "", category: "all" },
};

/* --------------------------------- helpers -------------------------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  show(t);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => hide(t), 2200);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("#theme-toggle").textContent = theme === "dark" ? "🌙" : "☀️";
}

async function ping() {
  chrome.runtime.sendMessage({ type: "ACTIVITY", minutes: state.settings.autoLockMinutes });
}

function initialsColor(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = text.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 48%)`;
}

function faviconOrigin(website) {
  try { return new URL(website).origin; } catch { return null; }
}

/* ------------------------------- bootstrap -------------------------------- */

document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireStaticEvents();
  state.settings = await store.getSettings();
  applyTheme(state.settings.theme);

  const initialized = await store.isInitialized();
  if (!initialized) {
    showLock("setup");
    return;
  }

  // Try to resume an unlocked session.
  const { [SESSION_KEY]: cached } = await chrome.storage.session.get(SESSION_KEY);
  if (cached) {
    try {
      state.key = await importKey(cached);
      await openDashboard();
      return;
    } catch {
      await chrome.storage.session.remove(SESSION_KEY);
    }
  }
  showLock("unlock");
}

function showLock(mode) {
  show($("#lock-screen"));
  hide($("#dashboard"));
  if (mode === "setup") {
    show($("#setup-form"));
    hide($("#unlock-form"));
    $("#setup-pass").focus();
  } else {
    show($("#unlock-form"));
    hide($("#setup-form"));
    $("#unlock-pass").focus();
  }
}

/* ----------------------------- event wiring ------------------------------- */

function wireStaticEvents() {
  // Setup
  $("#setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p1 = $("#setup-pass").value;
    const p2 = $("#setup-pass2").value;
    const err = $("#setup-error");
    err.textContent = "";
    if (p1.length < 8) return (err.textContent = "Use at least 8 characters.");
    if (p1 !== p2) return (err.textContent = "Passwords do not match.");
    state.key = await store.initializeVault(p1);
    await cacheSession();
    await openDashboard();
  });

  // Unlock
  $("#unlock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#unlock-error");
    err.textContent = "";
    try {
      state.key = await store.unlock($("#unlock-pass").value);
      await cacheSession();
      await openDashboard();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  // Topbar
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#lock-btn").addEventListener("click", lockVault);
  $("#add-btn").addEventListener("click", () => openModal());
  $("#empty-add-btn").addEventListener("click", () => openModal());

  // Search / filter
  $("#search").addEventListener("input", (e) => {
    state.filter.search = e.target.value.trim().toLowerCase();
    renderLists();
  });

  // Modal
  $("#modal-close").addEventListener("click", closeModal);
  $("#cancel-btn").addEventListener("click", closeModal);
  $("#modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
  $("#account-form").addEventListener("submit", saveAccount);
  $("#delete-btn").addEventListener("click", deleteCurrent);
  $("#acc-pw-toggle").addEventListener("click", () => {
    const inp = $("#acc-password");
    inp.type = inp.type === "password" ? "text" : "password";
  });

  document.addEventListener("click", ping, { capture: true });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

async function cacheSession() {
  const exported = await exportKey(state.key);
  await chrome.runtime.sendMessage({
    type: "SET_SESSION",
    exportedKey: exported,
    minutes: state.settings.autoLockMinutes,
  });
}

async function toggleTheme() {
  const next = state.settings.theme === "dark" ? "light" : "dark";
  state.settings = await store.updateSettings({ theme: next });
  applyTheme(next);
}

async function lockVault() {
  await chrome.runtime.sendMessage({ type: "LOCK" });
  state.key = null;
  $("#unlock-pass").value = "";
  showLock("unlock");
}

/* ------------------------------ dashboard --------------------------------- */

async function openDashboard() {
  hide($("#lock-screen"));
  show($("#dashboard"));
  await loadAccounts();
  buildCategoryChips();
  buildCategoryDatalist();
  renderLists();
  await ping();
}

async function loadAccounts() {
  const raw = await store.getAccountsRaw();
  const decrypted = [];
  for (const acc of raw) {
    let username = "";
    try {
      username = await decrypt(state.key, acc.username);
    } catch {
      username = "••••";
    }
    decrypted.push({ ...acc, usernamePlain: username });
  }
  state.accounts = decrypted;
}

function categoriesInUse() {
  const set = new Set(PRESET_CATEGORIES);
  state.accounts.forEach((a) => a.category && set.add(a.category));
  return [...set];
}

function buildCategoryChips() {
  const wrap = $("#category-chips");
  const cats = ["all", ...new Set(state.accounts.map((a) => a.category || "Other"))];
  wrap.innerHTML = "";
  cats.forEach((cat) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.filter.category === cat ? " active" : "");
    chip.textContent = cat === "all" ? "All" : cat;
    chip.addEventListener("click", () => {
      state.filter.category = cat;
      buildCategoryChips();
      renderLists();
    });
    wrap.appendChild(chip);
  });
}

function buildCategoryDatalist() {
  const dl = $("#category-options");
  dl.innerHTML = categoriesInUse()
    .map((c) => `<option value="${escapeHtml(c)}"></option>`)
    .join("");
}

function matchesFilter(acc) {
  const { search, category } = state.filter;
  if (category !== "all" && (acc.category || "Other") !== category) return false;
  if (!search) return true;
  return (
    acc.name.toLowerCase().includes(search) ||
    (acc.usernamePlain || "").toLowerCase().includes(search) ||
    (acc.website || "").toLowerCase().includes(search) ||
    (acc.category || "").toLowerCase().includes(search) ||
    (acc.usage || "").toLowerCase().includes(search)
  );
}

function renderLists() {
  const filtered = state.accounts.filter(matchesFilter);

  // Empty state (no accounts at all)
  if (state.accounts.length === 0) {
    hide($("#fav-section"));
    hide($("#recent-section"));
    hide($("#all-section"));
    show($("#empty-state"));
    return;
  }
  hide($("#empty-state"));

  // Favorites (only when no active search/category narrowing hides them)
  const favs = filtered.filter((a) => a.favorite);
  renderGrid($("#fav-list"), favs);
  $("#fav-section").classList.toggle("hidden", favs.length === 0);

  // Recently used (top 4 by lastUsed)
  const recent = filtered
    .filter((a) => a.lastUsed)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, 4);
  renderGrid($("#recent-list"), recent);
  $("#recent-section").classList.toggle("hidden", recent.length === 0);

  // All
  const all = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  renderGrid($("#all-list"), all);
  $("#all-count").textContent = all.length;
  show($("#all-section"));
}

function renderGrid(container, accounts) {
  container.innerHTML = "";
  accounts.forEach((acc) => container.appendChild(buildCard(acc)));
}

function buildCard(acc) {
  const card = document.createElement("div");
  card.className = "acc-card";
  card.title = "Click to log in";

  // Logo (favicon with initials fallback)
  const logo = document.createElement("div");
  logo.className = "acc-logo";
  logo.style.background = initialsColor(acc.name);
  logo.textContent = acc.name.charAt(0).toUpperCase();

  const origin = faviconOrigin(acc.website);
  if (origin) {
    const img = new Image();
    img.src = `${origin}/favicon.ico`;
    img.alt = "";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";
    img.onload = () => {
      logo.textContent = "";
      logo.style.background = "transparent";
      logo.appendChild(img);
    };
    img.onerror = () => {};
  }

  const main = document.createElement("div");
  main.className = "acc-main";
  main.innerHTML = `
    <div class="acc-name">${escapeHtml(acc.name)}</div>
    <div class="acc-user">${escapeHtml(acc.usernamePlain || "")}</div>
    <div class="acc-meta"><span class="acc-cat">${escapeHtml(acc.category || "Other")}</span></div>
  `;

  const actions = document.createElement("div");
  actions.className = "acc-actions";

  const favBtn = document.createElement("button");
  favBtn.className = "mini-btn" + (acc.favorite ? " fav-on" : "");
  favBtn.textContent = acc.favorite ? "★" : "☆";
  favBtn.title = "Toggle favorite";
  favBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await store.toggleFavorite(acc.id);
    acc.favorite = !acc.favorite;
    await loadAccounts();
    renderLists();
  });

  const editBtn = document.createElement("button");
  editBtn.className = "mini-btn";
  editBtn.textContent = "✎";
  editBtn.title = "Edit";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openModal(acc);
  });

  const copyBtn = document.createElement("button");
  copyBtn.className = "mini-btn";
  copyBtn.textContent = "⧉";
  copyBtn.title = "Copy password";
  copyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const full = await store.decryptAccount(state.key, acc);
    await navigator.clipboard.writeText(full.password);
    toast("Password copied");
  });

  actions.append(favBtn, editBtn, copyBtn);

  card.append(logo, main, actions);
  card.addEventListener("click", () => doLogin(acc));
  return card;
}

/* -------------------------------- login ----------------------------------- */

async function doLogin(acc) {
  const full = await store.decryptAccount(state.key, acc);
  toast("Opening & signing in…");
  const res = await chrome.runtime.sendMessage({
    type: "LOGIN",
    account: {
      website: full.website,
      username: full.username,
      password: full.password,
    },
  });
  if (res && res.ok) {
    await store.markUsed(acc.id);
    await loadAccounts();
    renderLists();
    window.close();
  } else {
    toast(res?.error || "Could not start login.");
  }
}

/* ------------------------------- modal CRUD ------------------------------- */

function openModal(acc) {
  const form = $("#account-form");
  form.reset();
  buildCategoryDatalist();

  if (acc) {
    $("#modal-title").textContent = "Edit Account";
    $("#acc-id").value = acc.id;
    $("#acc-name").value = acc.name;
    $("#acc-website").value = acc.website;
    $("#acc-username").value = acc.usernamePlain || "";
    $("#acc-password").value = "";
    $("#acc-category").value = acc.category || "";
    $("#acc-usage").value = acc.usage || "";
    $("#acc-favorite").checked = !!acc.favorite;
    $("#pw-edit-note").textContent = "Leave blank to keep the current password.";
    show($("#delete-btn"));
  } else {
    $("#modal-title").textContent = "Add Account";
    $("#acc-id").value = "";
    $("#pw-edit-note").textContent = "";
    hide($("#delete-btn"));
  }

  $("#acc-password").type = "password";
  show($("#modal-overlay"));
  $("#acc-name").focus();
}

function closeModal() {
  hide($("#modal-overlay"));
}

async function saveAccount(e) {
  e.preventDefault();
  const id = $("#acc-id").value;
  const data = {
    name: $("#acc-name").value,
    website: $("#acc-website").value,
    username: $("#acc-username").value,
    password: $("#acc-password").value,
    category: $("#acc-category").value || "Other",
    usage: $("#acc-usage").value,
    favorite: $("#acc-favorite").checked,
  };

  if (id) {
    // When editing, only send password if the user typed a new one.
    const patch = { ...data };
    if (data.password === "") delete patch.password;
    await store.updateAccount(state.key, id, patch);
    toast("Account updated");
  } else {
    await store.addAccount(state.key, data);
    toast("Account added");
  }

  closeModal();
  await loadAccounts();
  buildCategoryChips();
  buildCategoryDatalist();
  renderLists();
}

async function deleteCurrent() {
  const id = $("#acc-id").value;
  if (!id) return;
  if (!confirm("Delete this account? This cannot be undone.")) return;
  await store.deleteAccount(id);
  toast("Account deleted");
  closeModal();
  await loadAccounts();
  buildCategoryChips();
  renderLists();
}

/* -------------------------------- utility --------------------------------- */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
