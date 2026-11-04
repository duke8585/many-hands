"use strict";

// ---------- state ----------

const TABS = ["signup", "overview", "builder", "versions"];

// [dot, soft background, ink] per role, ordered so neighbours contrast strongly.
// Greens and reds are left out: they mean "full" / "open".
const ROLE_PALETTE = [
  ["#3b82f6", "#dbeafe", "#1e40af"], // blue
  ["#f97316", "#ffedd5", "#9a3412"], // orange
  ["#8b5cf6", "#ede9fe", "#5b21b6"], // violet
  ["#eab308", "#fef9c3", "#854d0e"], // yellow
  ["#ec4899", "#fce7f3", "#9d174d"], // pink
  ["#06b6d4", "#cffafe", "#155e75"], // cyan
  ["#78716c", "#f5f5f4", "#44403c"], // stone
  ["#6366f1", "#e0e7ff", "#3730a3"], // indigo
];

// Desktop column layout of the builder (header + rows); phones stack each row as a card.
const BUILDER_COLS = "sm:grid-cols-[minmax(9rem,1.4fr)_minmax(9rem,1fr)_6.5rem_6.5rem_4.5rem_5.5rem_auto]";

const state = {
  planId: null,
  data: null, // GET /plans/:id response
  roleColors: new Map(),
  tab: "signup",
  unlocked: false,
  rows: null, // builder working copy
  versions: null,
  me: getLastName(), // name used for "Sign up" buttons, remembered across visits
  onlyOpen: false,
  passwords: new Map(), // planId -> admin password, kept in memory for this page load only
  pwFails: new Map(), // planId -> wrong admin password tries this page load (hint from the 3rd on)
  autoUnlock: null, // planId whose builder opens unlocked (right after creating it)
  appVersion: null, // deploy version seen on first API call
};

const app = document.getElementById("app");
document.getElementById("modal-cancel").addEventListener("click", () => document.getElementById("modal").close());

// Texts that live in index.html, plus the DE/EN switch in the header.
function applyStaticTexts() {
  document.documentElement.lang = lang;
  const set = (id, text) => (document.getElementById(id).textContent = text);
  set("brand-name", t("appName"));
  set("update-text", t("updateAvailable"));
  set("update-reload", t("reload"));
  set("modal-cancel", t("cancel"));
  set("modal-ok", t("ok"));
  const gh = document.getElementById("gh-link");
  gh.title = t("ghTitle");
  gh.setAttribute("aria-label", t("ghTitle"));

  const sw = document.getElementById("lang-switch");
  sw.setAttribute("aria-label", t("language"));
  sw.replaceChildren(
    ...LANGS.map((code) =>
      h("button", {
        type: "button",
        lang: code,
        "aria-pressed": String(code === lang),
        class: code === lang
          ? "min-h-9 min-w-11 cursor-pointer rounded-full bg-white px-2.5 text-base font-bold text-stone-900 shadow-sm"
          : "min-h-9 min-w-11 cursor-pointer rounded-full px-2.5 text-base font-semibold text-stone-500 hover:text-stone-900",
        onclick: () => {
          if (code === lang) return;
          setLang(code);
          applyStaticTexts();
          // keep unsaved builder edits; everything else just re-renders
          if (state.planId && state.data) renderPlan();
          else route();
        },
      }, code.toUpperCase()),
    ),
  );
}
applyStaticTexts();

// ---------- helpers ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// Inline SVG icons (Lucide paths), drawn in currentColor.
const ICON_EDIT = '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>';
const ICON_SHARE = '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>';

function icon(paths) {
  const span = h("span", { class: "inline-flex", "aria-hidden": "true" });
  span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return span;
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  checkVersion(res.headers.get("x-app-version"));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.code && STRINGS.en[`err_${data.code}`] ? t(`err_${data.code}`, data.params || {}) : data.error;
    const err = new Error(message || t("requestFailed", res.status));
    err.status = res.status;
    err.params = data.params || {};
    throw err;
  }
  return data;
}

// A tab opened before a deploy keeps running old code (hash routing never reloads), so offer a reload.
function checkVersion(version) {
  if (!version) return;
  if (!state.appVersion) state.appVersion = version;
  else if (version !== state.appVersion) document.getElementById("update-banner").hidden = false;
}

function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtDate(iso) {
  return parseDate(iso).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function fmtDayLong(iso) {
  return parseDate(iso).toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function fmtDayShort(iso) {
  return parseDate(iso).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function fmtWhen(iso) {
  return new Date(iso).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
}

// "5 minutes ago", "yesterday", "3 days ago" ...
function fmtAgo(iso) {
  const seconds = (new Date(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return t("justNow");
}

function getLastName() {
  try {
    return localStorage.getItem("shiftPlanner.name") || "";
  } catch {
    return "";
  }
}

function setLastName(name) {
  try {
    localStorage.setItem("shiftPlanner.name", name);
  } catch {
    /* storage unavailable, ignore */
  }
}

function hash(text) {
  let x = 0;
  for (const c of text.toLowerCase()) x = (x * 31 + c.codePointAt(0)) >>> 0;
  return x;
}

// Roles get palette colors in order of first appearance (= builder row order), so the first
// few roles in a plan are always clearly distinct. Duplicated plans keep the same colors.
function computeRoleColors(roles) {
  return new Map([...new Set(roles)].map((role, i) => [role, ROLE_PALETTE[i % ROLE_PALETTE.length]]));
}

function roleStyle(role, colors = state.roleColors) {
  const [dot, soft, ink] = colors.get(role) || ["#a8a29e", "#f5f5f4", "#44403c"];
  return `--role:${dot};--role-soft:${soft};--role-ink:${ink}`;
}


let toastTimer;
function toast(message, action) {
  const el = document.getElementById("toast");
  el.replaceChildren(h("span", { class: "font-medium" }, message));
  if (action) {
    el.append(
      h("button", {
        class: "min-h-10 flex-none cursor-pointer rounded-full bg-white px-4 font-bold text-stone-900 hover:bg-stone-200",
        onclick: () => {
          el.hidden = true;
          action.run();
        },
      }, action.label),
    );
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 8000);
}

function showError(err) {
  toast(`⚠️ ${err.message}`);
}

// Password modal. `verify(pw)` should throw on a wrong password; the modal stays open and shows the error.
function askPassword({ title, text, verify, planId }) {
  const dialog = document.getElementById("modal");
  const form = dialog.querySelector("form");
  const input = document.getElementById("modal-input");
  const error = document.getElementById("modal-error");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-text").textContent = text;
  input.value = "";
  error.hidden = true;

  return new Promise((resolve) => {
    const onSubmit = async (e) => {
      e.preventDefault();
      const pw = input.value;
      if (!pw) return;
      try {
        if (verify) await verify(pw);
        cleanup();
        dialog.close();
        resolve(pw);
      } catch (err) {
        // From the 3rd wrong try on, show the masked hint (plans created before hints existed have none).
        const fails = (state.pwFails.get(planId) || 0) + 1;
        state.pwFails.set(planId, fails);
        const hint = fails >= 3 && err.params?.hint;
        error.textContent = hint ? `${err.message}. ${t("pwHint", hint)}` : err.message;
        error.hidden = false;
        input.select();
      }
    };
    const onClose = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("close", onClose);
    };
    form.addEventListener("submit", onSubmit);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    input.focus();
  });
}

// Returns the admin password to send (or "" if the plan has none), or null if the user cancelled.
// `alwaysAsk` ignores a password remembered from earlier in this page load.
async function adminAuth(plan, confirmText, alwaysAsk = false) {
  if (!plan.hasAdminPassword) return confirm(confirmText) ? "" : null;
  const known = state.passwords.get(plan.id);
  if (known && !alwaysAsk) return confirm(confirmText) ? known : null;
  const pw = await askPassword({
    title: t("adminPassword"),
    text: confirmText,
    verify: (p) => api("POST", `/plans/${plan.id}/verify`, { adminPassword: p }),
    planId: plan.id,
  });
  if (pw) state.passwords.set(plan.id, pw);
  return pw;
}

function emptyCard(text) {
  return h("div", { class: "card py-14 text-center text-lg text-stone-600" }, text);
}

// ---------- routing ----------

function route() {
  const [, page, id, tab] = location.hash.replace(/^#/, "").split("/");
  document.getElementById("gh-link").hidden = page === "plan" && !!id;
  if (page === "plan" && id) {
    if (id !== state.planId) {
      Object.assign(state, { planId: id, data: null, unlocked: false, rows: null, versions: null });
    }
    state.tab = TABS.includes(tab) ? tab : "signup";
    renderPlan();
  } else {
    state.planId = null;
    renderHome();
  }
  window.scrollTo({ top: 0, behavior: "instant" });
}

window.addEventListener("hashchange", route);
route();

// Keep sign-up / overview fresh while several people use the plan at once.
setInterval(() => {
  if (document.hidden || !state.planId || !["signup", "overview"].includes(state.tab)) return;
  if (!document.activeElement?.matches("input")) refreshPlan();
}, 30000);
// Print: switch to the print layout at A4-landscape width (277 x 190 mm printable at 10 mm margins),
// measure it and zoom it down so it fits one sheet. If that would go below MIN_PRINT_ZOOM (unreadable),
// print one sheet per day instead, zoomed so the tallest day fits.
const PRINT_W = (277 / 25.4) * 96;
const PRINT_H = (190 / 25.4) * 96;
const MIN_PRINT_ZOOM = 0.45;
window.addEventListener("beforeprint", () => {
  const root = document.documentElement;
  root.classList.add("printing");
  root.classList.remove("print-per-day");
  app.style.zoom = "";
  app.style.width = `${PRINT_W}px`;
  const fitWidth = (PRINT_W / app.scrollWidth) * 0.98;
  let zoom = Math.min(1, fitWidth, (PRINT_H / app.scrollHeight) * 0.97);

  const dayRows = [...app.querySelectorAll("tr.day-row")];
  if (zoom < MIN_PRINT_ZOOM && dayRows.length > 1) {
    root.classList.add("print-per-day");
    const top = app.getBoundingClientRect().top;
    const head = app.querySelector("thead").getBoundingClientRect();
    const tableBottom = app.querySelector("table").getBoundingClientRect().bottom;
    const tallest = Math.max(
      ...dayRows.map((row, i) => {
        const start = row.getBoundingClientRect().top;
        const end = dayRows[i + 1]?.getBoundingClientRect().top ?? tableBottom;
        return (i === 0 ? start - top : head.height) + (end - start); // first sheet also carries the title
      }),
    );
    zoom = Math.min(1, fitWidth, (PRINT_H / tallest) * 0.97);
  }
  zoom = Math.max(MIN_PRINT_ZOOM, zoom);
  app.style.zoom = String(zoom);
  app.style.width = `${PRINT_W / zoom}px`; // use the full sheet width at the reduced size
});
window.addEventListener("afterprint", () => {
  document.documentElement.classList.remove("printing", "print-per-day");
  app.style.zoom = "";
  app.style.width = "";
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.planId && state.tab !== "builder") refreshPlan();
});

// ---------- home ----------

async function renderHome() {
  document.title = t("appName");
  const nameInput = h("input", { class: "input", placeholder: t("planNamePh"), required: true, maxlength: 200 });
  const pwInput = h("input", { class: "input", type: "password", placeholder: t("optional"), autocomplete: "new-password" });
  const list = h("div", { class: "grid gap-4 sm:grid-cols-2" }, h("p", { class: "text-stone-500" }, t("loading")));

  app.replaceChildren(
    h("h1", { class: "text-3xl font-bold tracking-tight sm:text-4xl" }, t("home_title")),
    h("p", { class: "mt-2 text-lg text-stone-600" }, t("home_intro")),
    h("form", {
      class: "card mt-6 grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]",
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { id } = await api("POST", "/plans", { name: nameInput.value, adminPassword: pwInput.value || undefined });
          if (pwInput.value) state.passwords.set(id, pwInput.value);
          state.autoUnlock = id;
          location.hash = `#/plan/${id}/builder`;
        } catch (err) {
          showError(err);
        }
      },
    },
      h("label", { class: "label" }, t("planName"), nameInput),
      h("label", { class: "label" }, t("adminPassword"), pwInput),
      h("button", { class: "btn btn-primary" }, t("createPlan")),
    ),
    h("h2", { class: "mt-12 mb-4 text-2xl font-bold tracking-tight" }, t("existingPlans")),
    list,
  );

  try {
    const { plans } = await api("GET", "/plans");
    const active = plans.filter((p) => !p.archived_at);
    const archived = plans.filter((p) => p.archived_at);
    list.replaceChildren(...(active.length ? active.map(planCard) : [h("p", { class: "text-stone-500" }, t("noPlans"))]));
    if (archived.length) {
      app.append(
        h("button", {
          class: "mt-10 cursor-pointer text-base font-semibold text-stone-500 underline-offset-4 hover:text-stone-800 hover:underline",
          onclick: () => ((state.showArchived = !state.showArchived), renderHome()),
        }, state.showArchived ? t("hideArchived") : t("showArchived", archived.length)),
        state.showArchived ? h("div", { class: "mt-4 grid gap-4 sm:grid-cols-2" }, archived.map(planCard)) : "",
      );
    }
  } catch (err) {
    list.replaceChildren(h("p", { class: "font-semibold text-rose-700" }, err.message));
  }
}

function planCard(plan) {
  const auth = { id: plan.id, hasAdminPassword: !!plan.has_admin_password };
  const archived = !!plan.archived_at;
  return h("div", { class: archived ? "card flex flex-col gap-4 bg-stone-100" : "card flex flex-col gap-4" },
    h("div", null,
      h("a", { class: "text-xl font-bold tracking-tight hover:text-orange-700", href: `#/plan/${plan.id}` }, plan.name, plan.has_admin_password ? " 🔒" : ""),
      h("p", { class: "mt-1 text-base text-stone-600" },
        t("updatedPrefix"),
        h("time", { datetime: plan.updated_at, title: fmtWhen(plan.updated_at), class: "font-semibold text-stone-800" }, fmtAgo(plan.updated_at)),
      ),
      h("p", { class: "text-sm text-stone-500" }, t("created", fmtWhen(plan.created_at))),
    ),
    h("div", { class: "mt-auto grid grid-cols-2 gap-2" },
      h("a", { class: "btn btn-sm btn-primary px-2", href: `#/plan/${plan.id}` }, t("open")),
      h("button", {
        class: "btn btn-sm px-2",
        onclick: () => copyDialog(plan),
      }, t("duplicate")),
      h("button", {
        class: "btn btn-sm px-2",
        onclick: async () => {
          const pw = await adminAuth(auth, archived ? t("confirmUnarchive", plan.name) : t("confirmArchive", plan.name), true);
          if (pw === null) return;
          try {
            await api("POST", `/plans/${plan.id}/archive`, { adminPassword: pw || undefined, archived: !archived });
            toast(archived ? t("unarchivedToast") : t("archivedToast"));
            renderHome();
          } catch (err) {
            showError(err);
          }
        },
      }, archived ? t("unarchive") : t("archive")),
      h("button", {
        class: "btn btn-sm btn-danger px-2",
        onclick: async () => {
          const pw = await adminAuth(auth, t("confirmDelete", plan.name), true);
          if (pw === null || !confirm(t("confirmDeleteAgain", plan.name))) return;
          try {
            await api("DELETE", `/plans/${plan.id}`, { adminPassword: pw || undefined });
            toast(t("deleted"));
            renderHome();
          } catch (err) {
            showError(err);
          }
        },
      }, t("delete")),
    ),
  );
}

// Modal form built on the fly. `submit()` runs on OK; the dialog closes when it doesn't throw.
function formDialog({ title, fields, okLabel, submit }) {
  const dialog = h("dialog", { class: "m-auto w-[min(30rem,calc(100%-2rem))] rounded-3xl p-0 shadow-2xl backdrop:bg-stone-900/50 backdrop:backdrop-blur-sm" },
    h("form", {
      class: "flex flex-col gap-4 p-6",
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await submit();
          dialog.close();
        } catch (err) {
          showError(err);
        }
      },
    },
      h("h3", { class: "text-xl font-bold" }, title),
      fields,
      h("div", { class: "flex justify-end gap-3" },
        h("button", { type: "button", class: "btn", onclick: () => dialog.close() }, t("cancel")),
        h("button", { class: "btn btn-primary" }, okLabel),
      ),
    ),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector("input, textarea")?.select();
}

// Name, what to copy, and the copy's own optional admin password (the source password is not carried over).
function copyDialog(plan) {
  const nameInput = h("input", { class: "input", required: true, maxlength: 200, value: t("copyName", plan.name) });
  const pwInput = h("input", { class: "input", type: "password", placeholder: t("optional"), autocomplete: "new-password" });
  const option = (value, label, checked) =>
    h("label", { class: "flex min-h-11 cursor-pointer items-center gap-3 font-medium" },
      h("input", { type: "radio", name: "copy-what", value, checked, class: "size-5 flex-none accent-stone-900" }),
      label,
    );
  const what = h("fieldset", { class: "flex flex-col gap-1" },
    h("legend", { class: "mb-1 text-base font-semibold text-stone-700" }, t("copyWhat")),
    option("shifts", t("copyShiftsOnly"), true),
    option("all", t("copyWithPeople"), false),
  );
  formDialog({
    title: t("copyTitle"),
    okLabel: t("duplicate"),
    fields: [
      h("label", { class: "label" }, t("planName"), nameInput),
      what,
      h("label", { class: "label" }, t("adminPassword"), pwInput),
      h("p", { class: "text-base text-stone-600" }, t("copyPwNote")),
    ],
    submit: async () => {
      const withSignups = what.querySelector("input:checked").value === "all";
      await api("POST", `/plans/${plan.id}/duplicate`, { name: nameInput.value, adminPassword: pwInput.value || undefined, withSignups });
      toast(withSignups ? t("duplicatedAll") : t("duplicated"));
      renderHome();
    },
  });
}

// Name + description. Asks for the admin password first (remembered for this page load).
async function editDetails(plan) {
  let pw = "";
  if (plan.hasAdminPassword) {
    pw = state.passwords.get(plan.id) ?? (await askPassword({
      title: t("adminPassword"),
      text: t("pwEditDetails"),
      verify: (p) => api("POST", `/plans/${plan.id}/verify`, { adminPassword: p }),
      planId: plan.id,
    }));
    if (pw === null) return;
    state.passwords.set(plan.id, pw);
  }
  const nameInput = h("input", { class: "input", required: true, maxlength: 200, value: plan.name });
  const descInput = h("textarea", { class: "input min-h-32 py-3", maxlength: 2000, placeholder: t("descriptionPh") }, plan.description);
  formDialog({
    title: t("editDetails"),
    okLabel: t("save"),
    fields: [h("label", { class: "label" }, t("planName"), nameInput), h("label", { class: "label" }, t("description"), descInput)],
    submit: async () => {
      await api("PATCH", `/plans/${plan.id}`, { name: nameInput.value, description: descInput.value, adminPassword: pw || undefined });
      toast(t("detailsSaved"));
      await refreshPlan();
    },
  });
}

// ---------- plan view ----------

async function refreshPlan() {
  try {
    state.data = await api("GET", `/plans/${state.planId}`);
    state.roleColors = computeRoleColors(state.data.shifts.map((s) => s.role));
  } catch (err) {
    if (err.status === 404) {
      state.data = null;
      app.replaceChildren(
        h("h1", { class: "text-3xl font-bold" }, t("planNotFound")),
        h("a", { class: "mt-4 inline-block font-semibold text-orange-700", href: "#/" }, t("allPlans")),
      );
      return;
    }
    showError(err);
    return;
  }
  renderPlan();
}

function renderPlan() {
  if (!state.data) {
    app.replaceChildren(h("p", { class: "text-stone-500" }, t("loading")));
    refreshPlan();
    return;
  }
  const { plan } = state.data;
  document.title = `${plan.name} · ${t("appName")}`;

  if (state.autoUnlock === plan.id) {
    state.autoUnlock = null;
    openBuilder();
  }

  const body = h("div");
  app.replaceChildren(
    h("a", { class: "no-print inline-flex min-h-10 items-center text-base font-semibold text-stone-600 hover:text-stone-900", href: "#/" }, t("allPlans")),
    h("h1", { class: "mt-1 text-3xl font-bold tracking-tight sm:text-4xl" }, plan.name, plan.hasAdminPassword ? h("span", { class: "no-print" }, " 🔒") : ""),
    plan.description && h("p", { class: "mt-3 max-w-prose text-lg whitespace-pre-line text-stone-700" }, plan.description),
    h("div", { class: "no-print mt-3 flex flex-wrap items-center gap-3 text-base text-stone-500" },
      t("created", fmtWhen(plan.createdAt)),
      h("div", { class: "ml-auto flex gap-2" },
        h("button", { class: "btn-icon", title: t("editDetails"), "aria-label": t("editDetails"), onclick: () => editDetails(plan) }, icon(ICON_EDIT)),
        h("button", {
          class: "btn-icon",
          title: t("copyLink"),
          "aria-label": t("copyLink"),
          onclick: async () => {
            const link = `${location.origin}/#/plan/${plan.id}`;
            try {
              await navigator.clipboard.writeText(link);
              toast(t("linkCopied"));
            } catch {
              prompt(t("copyThisLink"), link);
            }
          },
        }, icon(ICON_SHARE)),
      ),
    ),
    h("nav", { class: "no-print mt-6 mb-8 flex gap-1 rounded-full max-[379px]:gap-0 max-[379px]:p-1 bg-stone-200/70 p-1.5" },
      TABS.map((key) =>
        h("button", {
          class: state.tab === key
            ? "min-h-11 flex-auto cursor-pointer rounded-full bg-white px-1.5 text-[16px] whitespace-nowrap max-[379px]:px-1 max-[379px]:text-[15px] max-[339px]:text-[14px] font-semibold text-stone-900 shadow-sm sm:px-4 sm:text-lg"
            : "min-h-11 flex-auto cursor-pointer rounded-full px-1.5 text-[16px] whitespace-nowrap max-[379px]:px-1 max-[379px]:text-[15px] max-[339px]:text-[14px] font-semibold text-stone-600 hover:text-stone-900 sm:px-4 sm:text-lg",
          "aria-current": state.tab === key ? "page" : null,
          onclick: () => (location.hash = `#/plan/${plan.id}/${key}`),
        }, t(`tab_${key}`)),
      ),
    ),
    body,
  );

  if (state.tab === "signup") body.append(renderSignupList());
  else if (state.tab === "overview") body.append(renderMatrix());
  else if (state.tab === "builder") body.append(renderBuilder());
  else renderVersions(body);
}

// ---------- shared bits ----------

function gridModel(shifts) {
  const roles = [];
  const slots = new Map(); // "date|time" -> { date, time }
  const byKey = new Map();
  for (const s of shifts) {
    if (!roles.includes(s.role)) roles.push(s.role);
    slots.set(`${s.date}|${s.startTime}`, { date: s.date, time: s.startTime });
    const key = `${s.role}|${s.date}|${s.startTime}`;
    if (!byKey.has(key)) byKey.set(key, s);
  }
  const sorted = [...slots.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { roles, slots: sorted, byKey };
}

function signupsByShift() {
  const byShift = new Map(state.data.shifts.map((s) => [s.id, []]));
  for (const u of state.data.signups) byShift.get(u.shiftId)?.push(u);
  return byShift;
}

function progressSummary(shifts, byShift) {
  const total = shifts.reduce((n, s) => n + s.capacity, 0);
  const filled = shifts.reduce((n, s) => n + Math.min(byShift.get(s.id).length, s.capacity), 0);
  return h("div", { class: "flex flex-col gap-2.5" },
    h("div", { class: "flex flex-wrap items-baseline gap-x-2 text-lg" },
      h("span", { class: "font-bold" }, t("filled", filled, total)),
      total > filled
        ? h("span", { class: "font-semibold text-rose-700" }, t("stillOpen", total - filled))
        : h("span", { class: "font-semibold text-emerald-700" }, t("allCovered")),
    ),
    h("div", { class: "h-2.5 overflow-hidden rounded-full bg-stone-200", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": total, "aria-valuenow": filled },
      h("div", { class: "h-full rounded-full bg-emerald-500 transition-all", style: `width:${total ? (filled / total) * 100 : 0}%` }),
    ),
  );
}

function initials(name) {
  const parts = name.split(/\s+/).filter((p) => /^\p{L}/u.test(p)); // skip "(Nachbarin)" etc.
  if (!parts.length) return name.trim().slice(0, 1).toUpperCase();
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// Name pill with a colored initial avatar; `onRemove` adds the × button.
function pill(name, onRemove) {
  const me = state.me.trim().toLowerCase();
  const isMe = me && name.toLowerCase() === me;
  return h("span", {
    class: `pill${onRemove ? "" : " pill-static"}${isMe ? " pill-me" : ""}`,
    style: `--h:${hash(name) % 360}`,
    "data-name": name.toLowerCase(),
  },
    h("span", { class: "avatar", "aria-hidden": "true" }, initials(name)),
    h("span", { class: "truncate" }, name, isMe ? h("span", { class: "me-tag font-semibold text-stone-500" }, t("you")) : null),
    onRemove && h("button", { class: "pill-x", title: t("removeName", name), "aria-label": t("removeName", name), onclick: onRemove }, "×"),
  );
}

function markMe() {
  const me = state.me.trim().toLowerCase();
  app.querySelectorAll(".pill").forEach((p) => {
    const isMe = !!me && p.dataset.name === me;
    p.classList.toggle("pill-me", isMe);
    const label = p.querySelector(".truncate");
    const tag = label.querySelector(".me-tag");
    if (isMe && !tag) label.append(h("span", { class: "me-tag font-semibold text-stone-500" }, t("you")));
    if (!isMe && tag) tag.remove();
  });
}

// ---------- sign-up list ----------

function renderSignupList() {
  const { shifts } = state.data;
  if (!shifts.length) return emptyCard(t("noShifts"));

  const byShift = signupsByShift();
  const isFull = (s) => byShift.get(s.id).length >= s.capacity;
  const openIn = (list) => list.reduce((n, s) => n + Math.max(0, s.capacity - byShift.get(s.id).length), 0);

  // date -> start time -> shifts, roles in builder order
  const { roles } = gridModel(shifts);
  const ordered = [...shifts].sort(
    (a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime) || roles.indexOf(a.role) - roles.indexOf(b.role),
  );
  const days = new Map();
  for (const s of ordered) {
    if (!days.has(s.date)) days.set(s.date, new Map());
    const slots = days.get(s.date);
    if (!slots.has(s.startTime)) slots.set(s.startTime, []);
    slots.get(s.startTime).push(s);
  }

  const jump = [];
  const sections = [];
  for (const [date, slots] of days) {
    const open = openIn([...slots.values()].flat());
    const slotEls = [];
    for (const [time, list] of slots) {
      const visible = state.onlyOpen ? list.filter((s) => !isFull(s)) : list;
      if (!visible.length) continue;
      // Show the end under the start time when the whole slot shares it, otherwise per shift.
      const ends = new Set(list.map((s) => s.endTime || ""));
      const sharedEnd = ends.size === 1 ? [...ends][0] : "";
      slotEls.push(
        h("div", { class: "grid gap-x-6 gap-y-3 border-t border-dashed border-stone-300 py-6 first:border-t-0 sm:grid-cols-[6.5rem_1fr]" },
          h("div", { class: "text-2xl font-bold tracking-tight tabular-nums sm:pt-4" },
            time,
            sharedEnd && h("span", { class: "ml-2 text-lg font-semibold text-stone-500 sm:ml-0 sm:block" }, t("slotTo", sharedEnd)),
          ),
          h("ul", { class: "flex flex-col gap-3" }, visible.map((s) => shiftItem(s, byShift.get(s.id), !sharedEnd))),
        ),
      );
    }
    if (!slotEls.length) continue;
    const id = `day-${date}`;
    jump.push(
      h("button", { class: "btn btn-sm", onclick: () => document.getElementById(id)?.scrollIntoView() },
        fmtDayShort(date),
        open
          ? h("span", { class: "badge bg-rose-100 text-rose-800" }, t("nOpen", open))
          : h("span", { class: "badge bg-emerald-100 text-emerald-800" }, t("dayFull")),
      ),
    );
    sections.push(
      h("section", { class: "mt-10 scroll-mt-24", id },
        h("h2", { class: "flex flex-wrap items-baseline justify-between gap-3 border-b-2 border-stone-200 pb-3 text-2xl font-bold tracking-tight" },
          fmtDayLong(date),
          h("span", { class: open ? "text-base font-semibold text-rose-700" : "text-base font-semibold text-emerald-700" },
            open ? t("daySpotsOpen", open) : t("dayAllFilled")),
        ),
        slotEls,
      ),
    );
  }

  const meInput = h("input", {
    id: "me",
    class: "input min-h-14 text-xl",
    value: state.me,
    placeholder: t("namePh"),
    maxlength: 100,
    autocomplete: "name",
    oninput: (e) => {
      state.me = e.target.value;
      setLastName(state.me.trim());
      markMe();
    },
  });

  return h("div", null,
    h("section", { class: "card flex flex-col gap-3" },
      h("label", { for: "me", class: "text-lg font-bold" }, t("yourName")),
      meInput,
      h("p", { class: "text-base text-stone-600" }, t("nameHint")),
      h("label", { class: "flex min-h-11 cursor-pointer items-center gap-3 font-medium" },
        h("input", { type: "checkbox", class: "size-6 flex-none", checked: state.onlyOpen, onchange: (e) => ((state.onlyOpen = e.target.checked), renderPlan()) }),
        t("onlyOpen"),
      ),
    ),
    h("div", { class: "mt-8" }, progressSummary(shifts, byShift)),
    jump.length > 1 && h("nav", { class: "mt-5 flex flex-wrap gap-2", "aria-label": t("jumpToDay") }, jump),
    sections.length ? sections : h("div", { class: "mt-8" }, emptyCard(t("everyFilled"))),
  );
}

function shiftItem(shift, people, showEnd) {
  const full = people.length >= shift.capacity;
  const countColor = full ? "text-emerald-700" : people.length ? "text-amber-700" : "text-rose-700";
  return h("li", {
    class: full
      ? "relative flex flex-col gap-3 rounded-3xl bg-emerald-100/70 py-4 pr-5 pl-8 ring-1 ring-emerald-300"
      : "relative flex flex-col gap-3 rounded-3xl bg-white py-4 pr-5 pl-8 shadow-sm ring-1 ring-stone-200/80",
    style: roleStyle(shift.role),
  },
    h("span", { class: "absolute inset-y-4 left-4 w-1.5 rounded-full bg-(--role)", "aria-hidden": "true" }),
    h("div", { class: "flex items-baseline justify-between gap-3" },
      h("h3", { class: "min-w-0 text-xl font-bold tracking-tight text-(--role-ink)" },
        shift.role,
        showEnd && shift.endTime && h("span", { class: "ml-2 font-semibold text-stone-500 italic" }, t("shiftUntil", shift.endTime)),
      ),
      h("span", { class: `flex-none text-sm font-bold tabular-nums ${countColor}` }, `${people.length}/${shift.capacity}`),
    ),
    (people.length || !full) && h("div", { class: "flex flex-wrap items-end justify-between gap-3" },
      h("div", { class: "flex min-w-0 flex-1 flex-wrap gap-1.5" }, people.map((u) => pill(u.name, () => removeSignup(shift, u)))),
      !full && h("button", { class: "btn btn-primary min-w-36 text-lg max-sm:w-full", onclick: () => signUpMe(shift, people) }, t("signUp")),
    ),
  );
}

function signUpMe(shift, people) {
  const name = state.me.trim();
  if (!name) {
    const input = document.getElementById("me");
    input.scrollIntoView({ block: "center" });
    input.focus();
    input.classList.remove("nudge");
    void input.offsetWidth; // restart the nudge animation
    input.classList.add("nudge");
    toast(t("typeNameFirst"));
    return;
  }
  if (people.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
    toast(t("alreadySignedUp", name));
    return;
  }
  addSignup(shift, name);
}

async function addSignup(shift, name) {
  try {
    const { id } = await api("POST", `/plans/${state.planId}/shifts/${shift.id}/signup`, { name });
    await refreshPlan();
    toast(t("signedUp", name, shift.role, fmtDayShort(shift.date), shift.startTime), {
      label: t("undo"),
      run: async () => {
        try {
          await api("DELETE", `/plans/${state.planId}/signups/${id}`);
          await refreshPlan();
          toast(t("signupUndone"));
        } catch (err) {
          showError(err);
        }
      },
    });
  } catch (err) {
    showError(err);
    if (err.status === 409 || err.status === 404) refreshPlan();
  }
}

async function removeSignup(shift, signup) {
  try {
    await api("DELETE", `/plans/${state.planId}/signups/${signup.id}`);
    await refreshPlan();
    toast(t("removed", signup.name, shift.role), {
      label: t("undo"),
      run: () => addSignup(shift, signup.name),
    });
  } catch (err) {
    showError(err);
    refreshPlan();
  }
}

// ---------- overview matrix (also the print view) ----------

function renderMatrix() {
  const { shifts } = state.data;
  if (!shifts.length) return emptyCard(t("noShifts"));

  const byShift = signupsByShift();
  const { roles, slots, byKey } = gridModel(shifts);
  const timesByDate = new Map();
  for (const { date, time } of slots) timesByDate.set(date, [...(timesByDate.get(date) || []), time]);
  const covered = new Set();

  const rows = [];
  let lastDate = null;
  for (const slot of slots) {
    if (slot.date !== lastDate) {
      lastDate = slot.date;
      rows.push(
        h("tr", { class: "day-row" },
          h("th", { colspan: roles.length + 1, class: "border-b border-stone-200 bg-stone-100 px-4 py-2.5 text-left text-lg font-bold" },
            h("span", { class: "sticky left-4" }, fmtDate(slot.date)),
          ),
        ),
      );
    }
    rows.push(
      h("tr", null,
        h("td", { class: "sticky left-0 z-[1] w-px border-b border-stone-100 bg-white px-3 py-3 align-top text-lg font-bold whitespace-nowrap tabular-nums sm:px-4" }, slot.time),
        roles.map((role) => {
          const key = `${role}|${slot.date}|${slot.time}`;
          if (covered.has(key)) return null;
          const shift = byKey.get(key);
          if (!shift) return h("td", { class: "hatch border-b border-l border-stone-100" });
          // A shift with an end time stretches down over the rows it covers,
          // stopping early if the same role has another shift starting there.
          let span = 1;
          if (shift.endTime) {
            for (const time of timesByDate.get(slot.date)) {
              if (time <= slot.time) continue;
              const next = `${role}|${slot.date}|${time}`;
              if ((shift.endTime > shift.startTime && time >= shift.endTime) || byKey.has(next)) break;
              covered.add(next);
              span++;
            }
          }
          return overviewCell(shift, byShift.get(shift.id), span);
        }),
      ),
    );
  }

  return h("div", { class: "flex flex-col gap-6" },
    h("div", { class: "flex flex-wrap items-end justify-between gap-4" },
      h("div", { class: "min-w-64 flex-1" }, progressSummary(shifts, byShift)),
      h("button", { class: "no-print btn", onclick: () => window.print() }, t("print")),
    ),
    h("div", { class: "flex flex-wrap gap-x-5 gap-y-2 text-base text-stone-600" },
      [["bg-emerald-100 ring-emerald-300", t("legendFull")], ["bg-orange-100 ring-orange-300", t("legendPartly")], ["bg-red-200 ring-red-300", t("legendNobody")]].map(([cls, label]) =>
        h("span", { class: "inline-flex items-center gap-2" }, h("span", { class: `size-4 rounded ring-1 ${cls}` }), label),
      ),
    ),
    h("div", { class: "print-wrap overflow-x-auto rounded-3xl bg-white shadow-sm ring-1 ring-stone-200/80" },
      h("table", { class: "w-full border-collapse text-left" },
        h("thead", null,
          h("tr", null,
            h("th", { class: "sticky left-0 z-[1] border-b border-stone-200 bg-white px-3 py-3 text-base font-semibold text-stone-500 sm:px-4" }, t("time")),
            roles.map((r) =>
              h("th", { class: "border-b border-l border-stone-200 px-3 py-3 text-lg font-bold tracking-tight text-(--role-ink) shadow-[inset_6px_0_0_var(--role)] sm:px-4", style: roleStyle(r) }, r),
            ),
          ),
        ),
        h("tbody", null, rows),
      ),
    ),
  );
}

function overviewCell(shift, people, span) {
  const open = shift.capacity - people.length;
  const rowspan = span > 1 ? span : null;
  const range = rowspan && h("div", { class: "mb-1.5 text-sm font-semibold text-stone-500 tabular-nums" }, `${shift.startTime}–${shift.endTime}`);
  const base = "min-w-36 border-b border-l sm:min-w-44 border-stone-100 px-3 py-3 align-top shadow-[inset_4px_0_0_var(--role)]";
  if (!people.length) {
    return h("td", { class: `${base} bg-red-200`, rowspan, style: roleStyle(shift.role) },
      range,
      h("span", { class: "font-bold text-red-900" }, t("nOpenParen", open)),
    );
  }
  return h("td", { class: open <= 0 ? `${base} bg-emerald-50` : `${base} bg-orange-100`, rowspan, style: roleStyle(shift.role) },
    range,
    h("div", { class: "pills flex flex-wrap gap-1.5" }, people.map((u) => pill(u.name))),
    open > 0 && h("div", { class: "mt-1.5 text-sm font-bold text-orange-800" }, t("nOpenParen", open)),
  );
}

// ---------- builder ----------

async function unlockBuilder() {
  const { plan, shifts } = state.data;
  if (plan.hasAdminPassword) {
    if (!state.passwords.has(plan.id) && (await adminAuth(plan, t("pwEdit"))) === null) return;
  } else if (shifts.length && !confirm(t("confirmEdit"))) {
    return;
  }
  openBuilder();
  renderPlan();
}

function layoutFields({ id, role, date, startTime, endTime, capacity }) {
  return { id, role, date, startTime, endTime: endTime || null, capacity };
}

function openBuilder() {
  state.unlocked = true;
  state.rows = state.data.shifts.map(layoutFields);
}

function renderBuilder() {
  if (!state.unlocked) {
    return h("div", { class: "card flex flex-col items-center gap-3 py-14 text-center" },
      h("div", { class: "grid size-16 place-items-center rounded-full bg-stone-100 text-3xl" }, "🔒"),
      h("h2", { class: "text-2xl font-bold tracking-tight" }, t("locked")),
      h("p", { class: "max-w-md text-stone-600" }, t("lockedHint")),
      h("button", { class: "btn btn-primary mt-2", onclick: unlockBuilder }, t("editLayout")),
    );
  }
  const list = h("div", { class: "flex flex-col gap-3 sm:gap-0" });
  const counter = h("span", { class: "text-stone-500" });
  const redraw = () => {
    const colors = computeRoleColors(state.rows.map((r) => (r.role || "").trim()).filter(Boolean));
    list.replaceChildren(...state.rows.map((row, i) => builderRow(row, i, redraw, colors)));
    counter.textContent = t("rows", state.rows.length);
  };
  redraw();

  return h("div", { class: "flex flex-col gap-5" },
    // stays reachable while scrolling through long layouts
    h("div", { class: "sticky top-16 z-10 -mx-4 flex flex-wrap items-center gap-3 bg-stone-50/90 px-4 py-3 backdrop-blur-lg sm:-mx-6 sm:px-6" },
      h("button", { class: "btn btn-primary", onclick: saveLayout }, t("saveLayout")),
      h("button", { class: "btn", onclick: cancelBuilder }, t("cancel")),
      h("span", { class: "flex-1" }),
      counter,
    ),
    quickGenerate(redraw),
    // phone: one card per row; desktop: one line per row inside a single card
    h("div", { class: "sm:overflow-hidden sm:rounded-3xl sm:bg-white sm:shadow-sm sm:ring-1 sm:ring-stone-200/80" },
      h("div", { class: `hidden gap-2 px-4 pt-4 pb-2 text-sm font-semibold tracking-wide text-stone-500 uppercase sm:grid ${BUILDER_COLS}` },
        [t("colRole"), t("colDate"), t("colStart"), t("colEnd"), t("colSpots"), "", ""].map((label) => h("span", null, label)),
      ),
      list,
    ),
    h("div", null,
      h("button", {
        class: "btn",
        onclick: () => {
          const last = state.rows[state.rows.length - 1];
          state.rows.push(last ? { ...last, id: undefined } : { role: "", date: "", startTime: "", endTime: "", capacity: 1 });
          redraw();
        },
      }, t("addRow")),
    ),
  );
}

function builderRow(row, i, redraw, colors) {
  // Labels are visible on phones only; on desktop the header row names the columns.
  const field = (label, span, input) =>
    h("label", { class: `flex min-w-0 flex-col gap-1 text-sm font-semibold text-stone-500 ${span} sm:col-span-1` },
      h("span", { class: "sm:hidden" }, label),
      input,
    );
  const bind = (key, { label, ...props }) =>
    h("input", {
      class: "input min-h-11 px-3 text-base",
      "aria-label": label,
      ...props,
      value: row[key] ?? "",
      oninput: (e) => (row[key] = props.type === "number" ? Number(e.target.value) : e.target.value),
    });
  const signupCount = row.id ? state.data.signups.filter((u) => u.shiftId === row.id).length : 0;
  const role = (row.role || "").trim();
  return h("div", {
    class: `grid grid-cols-2 items-end gap-x-2 gap-y-3 rounded-3xl p-4 ring-1 sm:items-center sm:gap-y-0 sm:rounded-none sm:border-t sm:border-stone-100 sm:px-4 sm:py-2 sm:shadow-none sm:ring-0 ${BUILDER_COLS} ${
      row.dupe ? "bg-rose-50 ring-rose-300" : "bg-white shadow-sm ring-stone-200/80"}`,
    style: role ? roleStyle(role, colors) : null,
  },
    h("div", { class: "col-span-2 flex items-center gap-2.5 sm:col-span-1" },
      h("span", { class: role ? "size-3.5 flex-none rounded-full bg-(--role)" : "size-3.5 flex-none rounded-full bg-stone-200", "aria-hidden": "true" }),
      h("input", {
        class: "input min-h-11 px-3 text-base font-semibold",
        placeholder: t("colRole"),
        "aria-label": t("colRole"),
        maxlength: 100,
        value: row.role ?? "",
        oninput: (e) => (row.role = e.target.value),
        onchange: redraw, // recolor once the name is final
      }),
    ),
    field(t("colDate"), "col-span-2", bind("date", { type: "date", label: t("colDate") })),
    field(t("colStart"), "col-span-1", bind("startTime", { type: "time", label: t("colStart") })),
    field(t("colEnd"), "col-span-1", bind("endTime", { type: "time", label: t("colEndOptional") })),
    field(t("colSpots"), "col-span-1", bind("capacity", { type: "number", min: 1, max: 1000, label: t("colSpots") })),
    h("div", { class: "self-center text-sm font-semibold text-stone-500 max-sm:pt-5" }, signupCount ? t("signedUpCount", signupCount) : ""),
    h("div", { class: "col-span-2 sm:col-span-1" },
      h("div", { class: "flex justify-end gap-1.5" },
        h("button", {
          class: "btn btn-sm px-3",
          title: t("dupRow"),
          "aria-label": t("dupRow"),
          onclick: () => {
            state.rows.splice(i + 1, 0, { ...row, id: undefined, dupe: false });
            redraw();
          },
        }, "⧉"),
        h("button", {
          class: "btn btn-sm btn-danger px-3",
          title: t("delRow"),
          "aria-label": t("delRow"),
          onclick: () => {
            state.rows.splice(i, 1);
            redraw();
          },
        }, "🗑"),
      ),
    ),
  );
}

function quickGenerate(redraw) {
  const today = new Date().toISOString().slice(0, 10);
  const f = {
    role: h("input", { class: "input", placeholder: t("rolePh") }),
    from: h("input", { class: "input", type: "date", value: today }),
    to: h("input", { class: "input", type: "date", value: today }),
    start: h("input", { class: "input", type: "time", value: "14:00" }),
    end: h("input", { class: "input", type: "time", value: "22:00" }),
    hours: h("input", { class: "input", type: "number", value: 2, min: 0.25, step: 0.25 }),
    cap: h("input", { class: "input", type: "number", value: 1, min: 1 }),
  };
  const field = (label, input) => h("label", { class: "label" }, label, input);

  const generate = (e) => {
    e.preventDefault();
    const role = f.role.value.trim();
    const step = Math.round(Number(f.hours.value) * 60);
    const cap = Number(f.cap.value);
    const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
    const startMin = toMin(f.start.value || "00:00");
    const endMin = toMin(f.end.value || "00:00");
    if (!role || !f.from.value || !f.to.value) return alert(t("qgErrRequired"));
    if (f.to.value < f.from.value) return alert(t("qgErrDates"));
    if (endMin <= startMin) return alert(t("qgErrTimes"));
    if (!(step > 0) || !Number.isInteger(cap) || cap < 1) return alert(t("qgErrPositive"));

    const dates = [];
    for (let d = new Date(`${f.from.value}T00:00:00Z`); d <= new Date(`${f.to.value}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    const times = [];
    for (let min = startMin; min + step <= endMin; min += step) times.push([hhmm(min), hhmm(min + step)]);
    if (!times.length) return alert(t("qgErrTooLong"));
    const count = dates.length * times.length;
    if (count > 300 && !confirm(t("qgConfirmMany", count))) return;
    for (const date of dates) {
      for (const [startTime, endTime] of times) state.rows.push({ role, date, startTime, endTime, capacity: cap });
    }
    redraw();
    toast(t("qgAdded", count, dates.length, times.length));
  };

  return h("details", { class: "card group", open: state.rows.length === 0 },
    h("summary", { class: "flex cursor-pointer list-none items-center justify-between gap-3 text-lg font-bold" },
      h("span", null, t("qg")),
      h("span", { class: "text-base font-semibold text-stone-500 group-open:hidden" }, t("show")),
    ),
    h("p", { class: "mt-2 text-base text-stone-600" }, t("qgHint")),
    h("form", { class: "mt-5 grid grid-cols-2 items-end gap-4 sm:grid-cols-4", onsubmit: generate },
      h("div", { class: "col-span-2" }, field(t("colRole"), f.role)),
      h("div", { class: "col-span-2 sm:col-span-1" }, field(t("dateFrom"), f.from)),
      h("div", { class: "col-span-2 sm:col-span-1" }, field(t("dateTo"), f.to)),
      field(t("startTime"), f.start),
      field(t("endTime"), f.end),
      field(t("slotLength"), f.hours),
      field(t("spotsPerSlot"), f.cap),
      h("button", { class: "btn btn-primary col-span-2 sm:col-span-4 sm:justify-self-start" }, t("generate")),
    ),
  );
}

async function saveLayout() {
  const rows = state.rows;
  const seen = new Map();
  let dupes = 0;
  rows.forEach((r, i) => {
    r.role = (r.role || "").trim();
    const key = `${r.role}|${r.date}|${r.startTime}`;
    r.dupe = seen.has(key);
    if (r.dupe) {
      dupes++;
      rows[seen.get(key)].dupe = true;
    } else seen.set(key, i);
  });
  if (dupes) {
    renderPlan();
    return alert(t("errDupes"));
  }
  if (rows.some((r) => !r.role || !r.date || !r.startTime)) return alert(t("errRowFields"));

  const keptIds = new Set(rows.map((r) => r.id).filter(Boolean));
  const lost = state.data.signups.filter((u) => !keptIds.has(u.shiftId));
  if (lost.length && !confirm(t("confirmLost", lost.length))) return;

  try {
    await api("PUT", `/plans/${state.planId}/shifts`, {
      shifts: rows.map(layoutFields),
      adminPassword: state.passwords.get(state.planId),
    });
    state.unlocked = false;
    state.rows = null;
    state.versions = null;
    toast(t("layoutSaved"));
    await refreshPlan();
    location.hash = `#/plan/${state.planId}/signup`;
  } catch (err) {
    showError(err);
  }
}

function cancelBuilder() {
  const original = JSON.stringify(state.data.shifts.map(layoutFields));
  const current = JSON.stringify(state.rows.map(layoutFields));
  if (original !== current && !confirm(t("confirmDiscard"))) return;
  state.unlocked = false;
  state.rows = null;
  renderPlan();
}

// ---------- versions ----------

async function renderVersions(container) {
  container.replaceChildren(h("p", { class: "text-stone-500" }, t("loading")));
  try {
    const { versions } = await api("GET", `/plans/${state.planId}/versions`);
    state.versions = versions;
  } catch (err) {
    container.replaceChildren(h("p", { class: "font-semibold text-rose-700" }, err.message));
    return;
  }
  const latest = state.versions[0]?.version_number;
  container.replaceChildren(
    h("p", { class: "mb-5 text-stone-600" }, t("versionsHint")),
    h("ol", { class: "divide-y divide-stone-100 overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-stone-200/80" },
      state.versions.map((v) =>
        h("li", { class: "flex items-center gap-4 px-4 py-3.5 sm:px-5" },
          h("div", { class: "min-w-0 flex-1" },
            h("div", { class: "text-sm font-semibold text-stone-500 tabular-nums" }, `#${v.version_number} · ${fmtWhen(v.created_at)}`),
            h("div", { class: "break-words" }, translateVersion(v.description)),
          ),
          v.version_number === latest
            ? h("span", { class: "badge flex-none bg-stone-100 text-stone-600" }, t("current"))
            : h("button", { class: "btn btn-sm flex-none", onclick: () => restoreVersion(v.version_number) }, t("restore")),
        ),
      ),
    ),
  );
}

async function restoreVersion(n) {
  const pw = await adminAuth(state.data.plan, t("confirmRestore", n));
  if (pw === null) return;
  try {
    await api("POST", `/plans/${state.planId}/versions/${n}/restore`, { adminPassword: pw || undefined });
    state.unlocked = false;
    state.rows = null;
    toast(t("restored", n));
    await refreshPlan();
  } catch (err) {
    showError(err);
  }
}
