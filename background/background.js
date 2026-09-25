/**
 * background/background.js  (MV3 service worker)
 * -----------------------------------------------------------------------------
 * Responsibilities:
 *   1. Session key lifecycle + auto-lock (chrome.alarms + chrome.storage.session)
 *   2. Login orchestration: open/focus the target tab, inject the content
 *      script, and hand it the credentials to auto-fill.
 *
 * The service worker never decrypts anything. The popup derives the key from
 * the master password and passes already-decrypted credentials for the single
 * login action requested by the user.
 * -----------------------------------------------------------------------------
 */

const LOCK_ALARM = "salm-autolock";
const SESSION_KEY = "sessionKey";
const AUTOFILL_TIMEOUT_MS = 45000;

/* --------------------------- session / auto-lock -------------------------- */

async function armAutoLock(minutes) {
  const delay = Math.max(1, Number(minutes) || 5);
  await chrome.alarms.clear(LOCK_ALARM);
  chrome.alarms.create(LOCK_ALARM, { delayInMinutes: delay });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOCK_ALARM) {
    chrome.storage.session.remove(SESSION_KEY);
  }
});

/* -------------------------------- messaging ------------------------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case "SET_SESSION":
      chrome.storage.session
        .set({ [SESSION_KEY]: msg.exportedKey })
        .then(() => armAutoLock(msg.minutes))
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "ACTIVITY":
      armAutoLock(msg.minutes).then(() => sendResponse({ ok: true }));
      return true;

    case "LOCK":
      chrome.alarms.clear(LOCK_ALARM);
      chrome.storage.session.remove(SESSION_KEY).then(() => sendResponse({ ok: true }));
      return true;

    case "LOGIN":
      handleLogin(msg.account)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true; // async response

    default:
      return false;
  }
});

/* --------------------------------- login ---------------------------------- */

async function handleLogin(account) {
  if (!account?.website) throw new Error("This account has no website URL.");

  let origin;
  try {
    origin = new URL(account.website).origin;
  } catch {
    throw new Error("Invalid website URL.");
  }

  // Reuse an existing tab on the same origin if one is open, otherwise create it.
  const tabs = await chrome.tabs.query({});
  let tab = tabs.find((t) => t.url && safeOrigin(t.url) === origin);

  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    tab = await chrome.tabs.get(tab.id);
  } else {
    tab = await chrome.tabs.create({ url: account.website, active: true });
  }

  await waitForTabComplete(tab.id);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content/content.js"],
  });

  await chrome.tabs.sendMessage(tab.id, {
    type: "AUTOFILL",
    username: account.username,
    password: account.password,
    timeout: AUTOFILL_TIMEOUT_MS,
  });
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      // small settle delay so SPA login pages can mount their form
      setTimeout(resolve, 400);
    };

    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") finish();
    };

    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) return resolve();
      if (t && t.status === "complete") return finish();
      chrome.tabs.onUpdated.addListener(listener);
      // hard cap so we never hang forever
      setTimeout(finish, 15000);
    });
  });
}
