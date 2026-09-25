/**
 * storage.js
 * -----------------------------------------------------------------------------
 * JSON vault stored in chrome.storage.local. Username + password fields are
 * encrypted individually; everything else (name, website, category, ...) is
 * metadata used for search / display.
 *
 * Vault shape:
 * {
 *   version: 1,
 *   salt: "<base64 PBKDF2 salt>",
 *   verifier: { iv, data },          // encrypts a known string -> validates master password
 *   settings: { autoLockMinutes, theme },
 *   accounts: [{
 *     id, name, website, category, usage, favorite, createdAt, lastUsed,
 *     username: { iv, data },        // encrypted
 *     password: { iv, data }         // encrypted
 *   }]
 * }
 * -----------------------------------------------------------------------------
 */

import { deriveKey, encrypt, decrypt } from "./crypto.js";

const VERIFY_TEXT = "SALM_VERIFY_v1";
const DEFAULT_SETTINGS = { autoLockMinutes: 5, theme: "dark" };

/* --------------------------------- vault i/o ------------------------------ */

export async function getVault() {
  const { vault } = await chrome.storage.local.get("vault");
  return vault || null;
}

async function setVault(vault) {
  await chrome.storage.local.set({ vault });
}

export async function isInitialized() {
  const v = await getVault();
  return !!(v && v.verifier);
}

/* ------------------------- setup / unlock / relock ------------------------ */

/** First-run: create the vault and return the working key. */
export async function initializeVault(masterPassword) {
  const { key, salt } = await deriveKey(masterPassword);
  const verifier = await encrypt(key, VERIFY_TEXT);
  await setVault({
    version: 1,
    salt,
    verifier,
    settings: { ...DEFAULT_SETTINGS },
    accounts: [],
  });
  return key;
}

/** Validate the master password and return the working key, or throw. */
export async function unlock(masterPassword) {
  const vault = await getVault();
  if (!vault) throw new Error("Vault is not initialized.");
  const { key } = await deriveKey(masterPassword, vault.salt);
  try {
    const text = await decrypt(key, vault.verifier);
    if (text !== VERIFY_TEXT) throw new Error("mismatch");
  } catch {
    throw new Error("Invalid master password.");
  }
  return key;
}

/** Change the master password: re-encrypt every secret under a new key. */
export async function changeMasterPassword(oldKey, newMasterPassword) {
  const vault = await getVault();
  const { key: newKey, salt } = await deriveKey(newMasterPassword);

  const accounts = [];
  for (const acc of vault.accounts) {
    const username = await decrypt(oldKey, acc.username);
    const password = await decrypt(oldKey, acc.password);
    accounts.push({
      ...acc,
      username: await encrypt(newKey, username),
      password: await encrypt(newKey, password),
    });
  }

  vault.salt = salt;
  vault.verifier = await encrypt(newKey, VERIFY_TEXT);
  vault.accounts = accounts;
  await setVault(vault);
  return newKey;
}

/* -------------------------------- settings -------------------------------- */

export async function getSettings() {
  const vault = await getVault();
  return { ...DEFAULT_SETTINGS, ...(vault?.settings || {}) };
}

export async function updateSettings(patch) {
  const vault = await getVault();
  vault.settings = { ...DEFAULT_SETTINGS, ...(vault.settings || {}), ...patch };
  await setVault(vault);
  return vault.settings;
}

/* ------------------------------- account CRUD ----------------------------- */

/** Raw accounts (secrets still encrypted). */
export async function getAccountsRaw() {
  const vault = await getVault();
  return vault ? vault.accounts : [];
}

/** Decrypt a single stored account into a usable object. */
export async function decryptAccount(key, acc) {
  return {
    ...acc,
    username: await decrypt(key, acc.username),
    password: await decrypt(key, acc.password),
  };
}

export async function addAccount(key, data) {
  const vault = await getVault();
  const account = {
    id: crypto.randomUUID(),
    name: data.name?.trim() || "Untitled",
    website: data.website?.trim() || "",
    category: data.category?.trim() || "Other",
    usage: data.usage?.trim() || "",
    favorite: !!data.favorite,
    createdAt: Date.now(),
    lastUsed: null,
    username: await encrypt(key, data.username || ""),
    password: await encrypt(key, data.password || ""),
  };
  vault.accounts.push(account);
  await setVault(vault);
  return account;
}

export async function updateAccount(key, id, data) {
  const vault = await getVault();
  const idx = vault.accounts.findIndex((a) => a.id === id);
  if (idx === -1) throw new Error("Account not found.");

  const current = vault.accounts[idx];
  vault.accounts[idx] = {
    ...current,
    name: data.name?.trim() || current.name,
    website: data.website?.trim() ?? current.website,
    category: data.category?.trim() || current.category,
    usage: data.usage?.trim() ?? current.usage,
    favorite: data.favorite ?? current.favorite,
    username:
      data.username !== undefined ? await encrypt(key, data.username) : current.username,
    password:
      data.password !== undefined && data.password !== ""
        ? await encrypt(key, data.password)
        : current.password,
  };
  await setVault(vault);
  return vault.accounts[idx];
}

export async function deleteAccount(id) {
  const vault = await getVault();
  vault.accounts = vault.accounts.filter((a) => a.id !== id);
  await setVault(vault);
}

export async function toggleFavorite(id) {
  const vault = await getVault();
  const acc = vault.accounts.find((a) => a.id === id);
  if (acc) {
    acc.favorite = !acc.favorite;
    await setVault(vault);
  }
  return acc?.favorite;
}

export async function markUsed(id) {
  const vault = await getVault();
  const acc = vault.accounts.find((a) => a.id === id);
  if (acc) {
    acc.lastUsed = Date.now();
    await setVault(vault);
  }
}

/* ------------------------------ import / export --------------------------- */

/** Export the encrypted vault as-is (safe to back up; secrets stay encrypted). */
export async function exportVault() {
  const vault = await getVault();
  return JSON.stringify(vault, null, 2);
}

/** Replace the vault with an imported encrypted vault (must match same master password). */
export async function importVault(json) {
  const parsed = JSON.parse(json);
  if (!parsed.verifier || !parsed.salt || !Array.isArray(parsed.accounts)) {
    throw new Error("Invalid vault file.");
  }
  await setVault(parsed);
}
