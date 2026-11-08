// Many Hands API. Everything outside /api/* is served from ./public by the assets binding.

const MAX_VERSIONS = 100;
const PBKDF2_ITERATIONS = 100_000; // Workers caps PBKDF2 at 100k
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Sent with every API response so open tabs notice a new deploy and offer a reload.
let appVersion = "";

// `code` (+ `params`) lets the frontend show the message in the user's language; `message` stays English.
class HttpError extends Error {
  constructor(status, message, code, params) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      // Old links keep working but move to the custom domain, so new share links use it too.
      // 302, not 301: browsers cache 301s forever, which would make a later domain change sticky.
      if (env.LEGACY_HOST && url.hostname === env.LEGACY_HOST) {
        return Response.redirect(`${env.CANONICAL_ORIGIN}${url.pathname}${url.search}`, 302);
      }
      return env.ASSETS.fetch(request);
    }
    appVersion = env.CF_VERSION_METADATA?.id || "";
    try {
      return await route(request, env.DB, url.pathname.slice(4).split("/").filter(Boolean));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code, params: err.params }, err.status);
      console.error(err);
      return json({ error: "Internal error", code: "internal" }, 500);
    }
  },
};

async function route(request, db, parts) {
  const m = request.method;
  const [root, planId, sub, subId, action] = parts;
  if (root !== "plans") throw new HttpError(404, "Not found", "notFound");

  if (parts.length === 1) {
    if (m === "GET") return listPlans(db);
    if (m === "POST") return createPlan(db, await body(request));
  }
  if (parts.length === 2) {
    if (m === "GET") return getPlan(db, planId);
    if (m === "PATCH") return updatePlan(db, planId, await body(request));
    if (m === "DELETE") return deletePlan(db, planId, await body(request));
  }
  if (parts.length === 3) {
    if (sub === "duplicate" && m === "POST") return duplicatePlan(db, planId, await body(request));
    if (sub === "verify" && m === "POST") return verifyPlan(db, planId, await body(request));
    if (sub === "archive" && m === "POST") return archivePlan(db, planId, await body(request));
    if (sub === "shifts" && m === "PUT") return saveShifts(db, planId, await body(request));
    if (sub === "versions" && m === "GET") return listVersions(db, planId);
  }
  if (parts.length === 4 && sub === "signups" && m === "DELETE") return removeSignup(db, planId, subId);
  if (parts.length === 5) {
    if (sub === "shifts" && action === "signup" && m === "POST") return signup(db, planId, subId, await body(request));
    if (sub === "versions" && action === "restore" && m === "POST") return restoreVersion(db, planId, subId, await body(request));
  }
  throw new HttpError(404, "Not found", "notFound");
}

// ---------- handlers ----------

async function listPlans(db) {
  const { results } = await db
    .prepare(
      "SELECT id, name, created_at, updated_at, archived_at, admin_password_hash IS NOT NULL AS has_admin_password FROM plans ORDER BY created_at DESC",
    )
    .all();
  return json({ plans: results });
}

async function createPlan(db, { name, adminPassword }) {
  name = requireText(name, "Plan name", "planName", 200);
  const id = crypto.randomUUID();
  const now = nowIso();
  const hash = adminPassword ? await hashPassword(String(adminPassword)) : null;
  const hint = adminPassword ? passwordHint(String(adminPassword)) : null;
  await db
    .prepare("INSERT INTO plans (id, name, admin_password_hash, admin_password_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, name, hash, hint, now, now)
    .run();
  await addVersion(db, id, "Plan created");
  return json({ id }, 201);
}

// The copy gets its own (optional) password; the source password is never carried over.
// `withSignups` also copies the sign-ups and the version history; otherwise only the shifts.
async function duplicatePlan(db, planId, { name, adminPassword, withSignups = false }) {
  const plan = await loadPlan(db, planId);
  const newName = name ? requireText(name, "Plan name", "planName", 200) : `${plan.name} (copy)`;
  const id = crypto.randomUUID();
  const now = nowIso();
  const hash = adminPassword ? await hashPassword(String(adminPassword)) : null;
  const hint = adminPassword ? passwordHint(String(adminPassword)) : null;
  const { shifts, signups } = await loadState(db, planId);
  // Every shift/sign-up id (also those only in old snapshots) gets one new id, so restoring
  // a copied version in the copy never touches the original's rows.
  const ids = new Map();
  const newId = (old) => ids.get(old) ?? ids.set(old, crypto.randomUUID()).get(old);
  const stmts = [
    db
      .prepare(
        "INSERT INTO plans (id, name, description, admin_password_hash, admin_password_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(id, newName, plan.description, hash, hint, now, now),
    ...shifts.map((s) => insertShift(db, id, newId(s.id), s.role, s.date, s.start_time, s.end_time, s.capacity, s.sort_order)),
  ];
  if (withSignups) {
    stmts.push(
      ...signups.map((u) =>
        db.prepare("INSERT INTO signups (id, shift_id, name, created_at) VALUES (?, ?, ?, ?)").bind(newId(u.id), newId(u.shift_id), u.name, u.created_at),
      ),
    );
    const { results: versions } = await db.prepare("SELECT * FROM versions WHERE plan_id = ?").bind(planId).all();
    for (const v of versions) {
      const snap = JSON.parse(v.snapshot);
      snap.shifts = snap.shifts.map((s) => ({ ...s, id: newId(s.id), plan_id: id }));
      snap.signups = snap.signups.map((u) => ({ ...u, id: newId(u.id), shift_id: newId(u.shift_id) }));
      stmts.push(
        db
          .prepare("INSERT INTO versions (id, plan_id, version_number, snapshot, description, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), id, v.version_number, JSON.stringify(snap), v.description, v.created_at),
      );
    }
  }
  await db.batch(stmts);
  await addVersion(db, id, `Duplicated from "${plan.name}"`);
  return json({ id }, 201);
}

async function updatePlan(db, planId, { name, description, adminPassword }) {
  const plan = await loadPlan(db, planId);
  await requireAdmin(db, plan, adminPassword);
  name = requireText(name, "Plan name", "planName", 200);
  description = typeof description === "string" ? description.trim() : "";
  if (description.length > 2000) {
    throw new HttpError(400, "Description is too long (max 2000)", "tooLong", { field: "description", max: 2000 });
  }
  await db
    .prepare("UPDATE plans SET name = ?, description = ?, updated_at = ? WHERE id = ?")
    .bind(name, description || null, nowIso(), planId)
    .run();
  return json({ success: true });
}

// `archived: false` unarchives. Only hides the plan from the list; the plan itself is unchanged.
async function archivePlan(db, planId, { adminPassword, archived = true }) {
  const plan = await loadPlan(db, planId);
  await requireAdmin(db, plan, adminPassword);
  await db.prepare("UPDATE plans SET archived_at = ? WHERE id = ?").bind(archived ? nowIso() : null, planId).run();
  return json({ success: true });
}

async function deletePlan(db, planId, { adminPassword }) {
  const plan = await loadPlan(db, planId);
  await requireAdmin(db, plan, adminPassword);
  await db.batch([
    db.prepare("DELETE FROM signups WHERE shift_id IN (SELECT id FROM shifts WHERE plan_id = ?)").bind(planId),
    db.prepare("DELETE FROM shifts WHERE plan_id = ?").bind(planId),
    db.prepare("DELETE FROM versions WHERE plan_id = ?").bind(planId),
    db.prepare("DELETE FROM plans WHERE id = ?").bind(planId),
  ]);
  return json({ success: true });
}

async function verifyPlan(db, planId, { adminPassword }) {
  await requireAdmin(db, await loadPlan(db, planId), adminPassword);
  return json({ success: true });
}

async function getPlan(db, planId) {
  const plan = await loadPlan(db, planId);
  const { shifts, signups } = await loadState(db, planId);
  return json({
    plan: {
      id: plan.id,
      name: plan.name,
      description: plan.description || "",
      hasAdminPassword: !!plan.admin_password_hash,
      createdAt: plan.created_at,
    },
    shifts: shifts.map((s) => ({
      id: s.id,
      role: s.role,
      date: s.date,
      startTime: s.start_time,
      endTime: s.end_time,
      capacity: s.capacity,
      sortOrder: s.sort_order,
    })),
    signups: signups.map((u) => ({ id: u.id, shiftId: u.shift_id, name: u.name, createdAt: u.created_at })),
  });
}

async function saveShifts(db, planId, { shifts, adminPassword }) {
  const plan = await loadPlan(db, planId);
  await requireAdmin(db, plan, adminPassword);
  if (!Array.isArray(shifts)) throw new HttpError(400, "shifts must be an array", "badRequest");
  if (shifts.length > 2000) throw new HttpError(400, "Too many shifts", "badRequest");

  const { results: existing } = await db.prepare("SELECT id FROM shifts WHERE plan_id = ?").bind(planId).all();
  const existingIds = new Set(existing.map((r) => r.id));
  const keptIds = new Set();
  const stmts = [];

  shifts.forEach((s, i) => {
    const role = requireText(s.role, "Role", "role", 100);
    if (!DATE_RE.test(s.date || "")) throw new HttpError(400, `Row ${i + 1}: invalid date`, "rowDate", { row: i + 1 });
    if (!TIME_RE.test(s.startTime || "")) throw new HttpError(400, `Row ${i + 1}: invalid start time`, "rowStart", { row: i + 1 });
    const endTime = s.endTime || null;
    if (endTime && !TIME_RE.test(endTime)) throw new HttpError(400, `Row ${i + 1}: invalid end time`, "rowEnd", { row: i + 1 });
    const capacity = Number(s.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) {
      throw new HttpError(400, `Row ${i + 1}: capacity must be a whole number from 1 to 1000`, "rowCapacity", { row: i + 1 });
    }
    if (s.id && existingIds.has(s.id) && !keptIds.has(s.id)) {
      keptIds.add(s.id);
      stmts.push(
        db
          .prepare(
            "UPDATE shifts SET role = ?, date = ?, start_time = ?, end_time = ?, capacity = ?, sort_order = ? WHERE id = ? AND plan_id = ?",
          )
          .bind(role, s.date, s.startTime, endTime, capacity, i, s.id, planId),
      );
    } else {
      stmts.push(insertShift(db, planId, crypto.randomUUID(), role, s.date, s.startTime, endTime, capacity, i));
    }
  });

  const removed = [...existingIds].filter((id) => !keptIds.has(id));
  for (const id of removed) {
    stmts.unshift(db.prepare("DELETE FROM shifts WHERE id = ?").bind(id));
    stmts.unshift(db.prepare("DELETE FROM signups WHERE shift_id = ?").bind(id));
  }
  if (stmts.length) await db.batch(stmts);
  await addVersion(db, planId, `Layout saved (${shifts.length} shifts)`);
  return json({ success: true });
}

async function signup(db, planId, shiftId, { name }) {
  name = requireText(name, "Name", "name", 100);
  const shift = await db.prepare("SELECT * FROM shifts WHERE id = ? AND plan_id = ?").bind(shiftId, planId).first();
  if (!shift) throw new HttpError(404, "Shift not found", "shiftNotFound");
  const id = crypto.randomUUID();
  // Capacity check and insert in one statement, so concurrent sign-ups can't overfill a shift.
  const res = await db
    .prepare(
      `INSERT INTO signups (id, shift_id, name, created_at)
       SELECT ?, s.id, ?, ? FROM shifts s
       WHERE s.id = ? AND (SELECT COUNT(*) FROM signups WHERE shift_id = s.id) < s.capacity`,
    )
    .bind(id, name, nowIso(), shiftId)
    .run();
  if (!res.meta.changes) throw new HttpError(409, "This shift is already full", "full");
  await addVersion(db, planId, `${name} → ${describeShift(shift)}`);
  return json({ id, shiftId, name }, 201);
}

async function removeSignup(db, planId, signupId) {
  const row = await db
    .prepare(
      `SELECT u.name, s.role, s.date, s.start_time, s.end_time FROM signups u JOIN shifts s ON s.id = u.shift_id
       WHERE u.id = ? AND s.plan_id = ?`,
    )
    .bind(signupId, planId)
    .first();
  if (!row) throw new HttpError(404, "Sign-up not found", "signupNotFound");
  await db.prepare("DELETE FROM signups WHERE id = ?").bind(signupId).run();
  await addVersion(db, planId, `${row.name} ✗ ${describeShift(row)}`);
  return json({ success: true });
}

async function listVersions(db, planId) {
  await loadPlan(db, planId);
  const { results } = await db
    .prepare("SELECT version_number, description, created_at FROM versions WHERE plan_id = ? ORDER BY version_number DESC")
    .bind(planId)
    .all();
  return json({ versions: results });
}

async function restoreVersion(db, planId, versionNumber, { adminPassword }) {
  const plan = await loadPlan(db, planId);
  await requireAdmin(db, plan, adminPassword);
  const version = await db
    .prepare("SELECT snapshot FROM versions WHERE plan_id = ? AND version_number = ?")
    .bind(planId, Number(versionNumber))
    .first();
  if (!version) throw new HttpError(404, "Version not found", "versionNotFound");
  const snap = JSON.parse(version.snapshot);
  await db.batch([
    db.prepare("DELETE FROM signups WHERE shift_id IN (SELECT id FROM shifts WHERE plan_id = ?)").bind(planId),
    db.prepare("DELETE FROM shifts WHERE plan_id = ?").bind(planId),
    ...snap.shifts.map((s) =>
      insertShift(db, planId, s.id, s.role, s.date, s.start_time, s.end_time ?? null, s.capacity, s.sort_order),
    ),
    ...snap.signups.map((u) =>
      db.prepare("INSERT INTO signups (id, shift_id, name, created_at) VALUES (?, ?, ?, ?)").bind(u.id, u.shift_id, u.name, u.created_at),
    ),
  ]);
  await addVersion(db, planId, `Restored version #${Number(versionNumber)}`);
  return json({ success: true });
}

// ---------- helpers ----------

async function loadPlan(db, planId) {
  const plan = await db.prepare("SELECT * FROM plans WHERE id = ?").bind(planId).first();
  if (!plan) throw new HttpError(404, "Plan not found", "planNotFound");
  return plan;
}

async function loadState(db, planId) {
  const [shifts, signups] = await db.batch([
    db.prepare("SELECT * FROM shifts WHERE plan_id = ? ORDER BY sort_order, date, start_time").bind(planId),
    db
      .prepare(
        `SELECT u.* FROM signups u JOIN shifts s ON s.id = u.shift_id
         WHERE s.plan_id = ? ORDER BY u.created_at`,
      )
      .bind(planId),
  ]);
  return { shifts: shifts.results, signups: signups.results };
}

async function addVersion(db, planId, description) {
  const snapshot = JSON.stringify(await loadState(db, planId));
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO versions (id, plan_id, version_number, snapshot, description, created_at)
         SELECT ?, ?, COALESCE(MAX(version_number), 0) + 1, ?, ?, ? FROM versions WHERE plan_id = ?`,
      )
      .bind(crypto.randomUUID(), planId, snapshot, description, now, planId),
    db
      .prepare(
        `DELETE FROM versions WHERE plan_id = ?
         AND version_number <= (SELECT MAX(version_number) FROM versions WHERE plan_id = ?) - ?`,
      )
      .bind(planId, planId, MAX_VERSIONS),
    db.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").bind(now, planId),
  ]);
}

function insertShift(db, planId, id, role, date, startTime, endTime, capacity, sortOrder) {
  return db
    .prepare(
      "INSERT INTO shifts (id, plan_id, role, date, start_time, end_time, capacity, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, planId, role, date, startTime, endTime, capacity, sortOrder);
}

function describeShift(s) {
  return `${s.role}, ${s.date} ${s.start_time}${s.end_time ? `-${s.end_time}` : ""}`;
}

async function requireAdmin(db, plan, password) {
  if (!plan.admin_password_hash) return;
  if (!password || !(await checkPassword(String(password), plan.admin_password_hash))) {
    throw new HttpError(403, "Wrong admin password", "wrongPassword", { hint: plan.admin_password_hint });
  }
  // Plans created before hints existed get one the first time the right password is entered.
  if (!plan.admin_password_hint) {
    await db.prepare("UPDATE plans SET admin_password_hint = ? WHERE id = ?").bind(passwordHint(String(password)), plan.id).run();
  }
}

// "password" -> "p******d"; passwords of 3 characters or fewer are fully masked.
function passwordHint(password) {
  const chars = [...password];
  if (chars.length <= 3) return "*".repeat(chars.length);
  return chars[0] + "*".repeat(chars.length - 2) + chars[chars.length - 1];
}

async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

async function checkPassword(password, stored) {
  const [, , saltB64] = stored.split("$");
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const candidate = new TextEncoder().encode(await hashPassword(password, salt));
  const expected = new TextEncoder().encode(stored);
  return candidate.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(candidate, expected);
}

function b64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function requireText(value, label, field, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HttpError(400, `${label} is required`, "required", { field });
  if (text.length > maxLength) throw new HttpError(400, `${label} is too long (max ${maxLength})`, "tooLong", { field, max: maxLength });
  return text;
}

async function body(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new HttpError(400, "Invalid JSON body", "badRequest");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-app-version": appVersion },
  });
}
