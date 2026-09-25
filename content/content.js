/**
 * content/content.js
 * -----------------------------------------------------------------------------
 * Auto-fill state machine, injected on demand by the background service worker.
 *
 * Handles:
 *   - Generic single-page login forms (username + password together)
 *   - Multi-step flows (email -> Next -> password -> Sign in)
 *   - Microsoft / Azure AD (login.microsoftonline.com, login.live.com)
 *       * fills email (#i0116), clicks Next (#idSIButton9)
 *       * if a "sign-in method" picker appears, selects the Password option
 *       * fills password (#i0118), clicks Sign in
 *       * handles the "Stay signed in?" (KMSI) prompt
 *
 * The machine polls the DOM until the login is submitted or a timeout elapses,
 * so it works with SPA pages that render fields asynchronously.
 * -----------------------------------------------------------------------------
 */

(() => {
  // Guard against double-injection registering multiple listeners.
  if (window.__SALM_LOADED__) return;
  window.__SALM_LOADED__ = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "AUTOFILL") {
      runAutofill(msg.username, msg.password, msg.timeout || 45000);
      sendResponse({ ok: true });
    }
    return false;
  });

  /* ------------------------------ DOM helpers ----------------------------- */

  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
      return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const firstVisible = (selectors) => {
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const node of nodes) if (isVisible(node)) return node;
    }
    return null;
  };

  /** Set a value the way frameworks (React/Angular/Vue) expect. */
  const setNativeValue = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const fillField = (el, value) => {
    if (!el || el.value === value) return false;
    el.focus();
    setNativeValue(el, value);
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    return true;
  };

  const clickEl = (el) => {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
    return true;
  };

  const findByText = (selectors, textNeedle) => {
    const needle = textNeedle.toLowerCase();
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isVisible(el)) continue;
        const txt = (el.innerText || el.textContent || el.value || "").trim().toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        if (txt.includes(needle) || aria.includes(needle)) return el;
      }
    }
    return null;
  };

  /* ------------------------------ selectors ------------------------------- */

  const EMAIL_SELECTORS = [
    "#i0116", // Microsoft
    'input[name="loginfmt"]',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[name="username"]',
    'input[name="email"]',
    'input[id*="email" i]',
    'input[id*="user" i]',
    'input[type="text"][name*="user" i]',
  ];

  const PASSWORD_SELECTORS = [
    "#i0118", // Microsoft
    'input[type="password"]',
    'input[name="passwd"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
  ];

  const SUBMIT_SELECTORS = [
    "#idSIButton9", // Microsoft Next / Sign in
    'button[type="submit"]',
    'input[type="submit"]',
    "button[data-report-event]",
  ];

  /* --------------------------- state machine ------------------------------ */

  function runAutofill(username, password, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const st = {
      username,
      password,
      emailFilled: false,
      passwordFilled: false,
      pickerHandled: false,
      submittedEmail: false,
      submittedPassword: false,
      kmsiHandled: false,
    };

    notify("Signing you in…");

    const tick = () => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        return;
      }
      try {
        step(st);
      } catch (e) {
        /* keep polling — transient DOM states are expected */
      }
      if (st.submittedPassword && st.kmsiHandled) {
        clearInterval(timer);
      }
    };

    const timer = setInterval(tick, 600);
    tick();
  }

  function step(st) {
    const passwordField = firstVisible(PASSWORD_SELECTORS);
    const emailField = firstVisible(EMAIL_SELECTORS);

    // 1) Fill username / email as soon as it appears.
    if (emailField && !st.emailFilled) {
      if (fillField(emailField, st.username)) st.emailFilled = true;
    }

    // 2) Single-page form: both fields present -> fill password and submit.
    if (passwordField && emailField && st.emailFilled) {
      if (!st.passwordFilled) {
        fillField(passwordField, st.password);
        st.passwordFilled = true;
      }
      submit(st, "submittedPassword");
      return;
    }

    // 3) Multi-step: no password field yet -> advance from the email step.
    if (!passwordField) {
      // Microsoft/other "choose a sign-in method" pickers.
      handleMethodPicker(st);

      if (st.emailFilled && !st.submittedEmail) {
        const next =
          firstVisible(["#idSIButton9"]) ||
          findByText(["button", 'input[type="submit"]', "a[role='button']"], "next") ||
          findByText(["button", 'input[type="submit"]'], "continue") ||
          firstVisible(SUBMIT_SELECTORS);
        if (clickEl(next)) st.submittedEmail = true;
      }
      return;
    }

    // 4) Password screen is showing -> fill + submit.
    if (passwordField) {
      if (!st.passwordFilled) {
        if (fillField(passwordField, st.password)) st.passwordFilled = true;
      }
      if (st.passwordFilled) submit(st, "submittedPassword");
    }
  }

  /**
   * When several sign-in methods are offered, prefer "Password".
   * Covers the Microsoft credential picker and generic "other ways to sign in".
   */
  function handleMethodPicker(st) {
    if (st.pickerHandled) return;

    // Microsoft: link that opens the credential picker.
    const switchLink = document.querySelector("#idA_PWD_SwitchToCredPicker");
    if (isVisible(switchLink)) {
      clickEl(switchLink);
    }

    // Microsoft credential-picker tiles or a generic list of methods.
    const passwordTile =
      findByText(
        [
          "#idDiv_SAOTCS_Proofs div[role='button']",
          "div[role='button']",
          "div[data-value]",
          "button",
          "a[role='button']",
          "li",
        ],
        "password"
      ) ||
      findByText(["div[role='button']", "button", "a"], "use your password");

    // Only click if this really looks like a method chooser (a password field
    // isn't already on screen and the tile isn't the submit button itself).
    if (passwordTile && !firstVisible(PASSWORD_SELECTORS)) {
      if (passwordTile.id !== "idSIButton9") {
        clickEl(passwordTile);
        st.pickerHandled = true;
      }
    }
  }

  function submit(st, flag) {
    // Prefer the primary Microsoft button, else any submit control, else Enter.
    const btn =
      firstVisible(["#idSIButton9"]) ||
      findByText(["button", 'input[type="submit"]'], "sign in") ||
      findByText(["button", 'input[type="submit"]'], "log in") ||
      firstVisible(SUBMIT_SELECTORS);

    if (btn) {
      clickEl(btn);
      st[flag] = true;
    } else {
      const pwd = firstVisible(PASSWORD_SELECTORS);
      if (pwd) {
        pwd.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13 })
        );
        st[flag] = true;
      }
    }

    // Handle the Microsoft "Stay signed in?" (KMSI) prompt afterwards.
    setTimeout(() => handleKmsi(st), 1200);
  }

  function handleKmsi(st) {
    if (st.kmsiHandled) return;
    const kmsi = document.querySelector("#KmsiCheckboxField") || findByText(["div"], "stay signed in");
    if (isVisible(kmsi)) {
      // Click "Yes" to keep the session (the primary button on that page).
      const yes = firstVisible(["#idSIButton9"]);
      if (clickEl(yes)) st.kmsiHandled = true;
    } else {
      // No KMSI page appeared; consider this stage done.
      st.kmsiHandled = true;
    }
  }

  /* ------------------------------ small toast ----------------------------- */

  function notify(text) {
    try {
      const id = "salm-toast";
      document.getElementById(id)?.remove();
      const el = document.createElement("div");
      el.id = id;
      el.textContent = text;
      Object.assign(el.style, {
        position: "fixed",
        zIndex: 2147483647,
        right: "16px",
        bottom: "16px",
        padding: "10px 14px",
        borderRadius: "10px",
        background: "rgba(20,20,28,0.92)",
        color: "#fff",
        font: "13px/1.4 system-ui, sans-serif",
        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
      });
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 4000);
    } catch {
      /* ignore */
    }
  }
})();
