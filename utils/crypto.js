/**
 * crypto.js
 * -----------------------------------------------------------------------------
 * Cryptography utility built entirely on the Web Crypto API.
 *
 *  - Master password  -> PBKDF2 (SHA-256, 250k iterations) -> AES-GCM 256 key
 *  - Each secret field is encrypted with AES-GCM using a fresh random IV
 *  - Nothing sensitive is ever stored in plain text
 *
 * The derived key never leaves memory / chrome.storage.session. Only the salt,
 * IVs and ciphertext are persisted in chrome.storage.local.
 * -----------------------------------------------------------------------------
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export const PBKDF2_ITERATIONS = 250000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/* ------------------------------ base64 helpers ---------------------------- */

function toB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

/* ------------------------------ key derivation ---------------------------- */

/**
 * Derive an AES-GCM key from a master password.
 * @param {string} masterPassword
 * @param {string} [saltB64] - reuse an existing salt (unlock); omit to create one (setup)
 * @returns {Promise<{key: CryptoKey, salt: string}>}
 */
export async function deriveKey(masterPassword, saltB64) {
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  const baseKey = await crypto.subtle.importKey(
    "raw",
    ENC.encode(masterPassword),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true, // extractable so we can cache it in chrome.storage.session for the unlocked session
    ["encrypt", "decrypt"]
  );

  return { key, salt: toB64(salt) };
}

/* ------------------------------ encrypt / decrypt ------------------------- */

/**
 * Encrypt a UTF-8 string.
 * @param {CryptoKey} key
 * @param {string} plaintext
 * @returns {Promise<{iv: string, data: string}>}
 */
export async function encrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    ENC.encode(plaintext ?? "")
  );
  return { iv: toB64(iv), data: toB64(cipher) };
}

/**
 * Decrypt a payload produced by encrypt().
 * @param {CryptoKey} key
 * @param {{iv: string, data: string}} payload
 * @returns {Promise<string>}
 */
export async function decrypt(key, payload) {
  const iv = fromB64(payload.iv);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    fromB64(payload.data)
  );
  return DEC.decode(plain);
}

/* --------------------- session key (in-memory) portability ---------------- */

/** Export the raw key so it can be cached in chrome.storage.session. */
export async function exportKey(key) {
  return toB64(await crypto.subtle.exportKey("raw", key));
}

/** Re-import a raw key cached during an unlocked session. */
export async function importKey(b64) {
  return crypto.subtle.importKey(
    "raw",
    fromB64(b64),
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}
