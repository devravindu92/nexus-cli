// NEXUS cloud: accounts, trusted devices and synced metadata.
//
// It stores names and states that linked desktops choose to publish, and
// shows them in a browser. It never receives terminal input or output,
// commands, credentials or keys, and it cannot run anything on a device.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sanitizeState, validEmail } from "./sanitize.js";

const PORT = Number(process.env.PORT || 8080);
const SIGNUP_CODE = process.env.SIGNUP_CODE || "";
const SESSION_DAYS = 14;
const PAIR_MINUTES = 10;
const MAX_BODY = 600 * 1024;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS account (
  id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS web_session (
  token_hash TEXT PRIMARY KEY, account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS device (
  id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  name TEXT NOT NULL, platform TEXT NOT NULL, token_hash TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS pair_code (
  code_hash TEXT PRIMARY KEY, account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS device_state (
  device_id UUID PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit (
  id BIGSERIAL PRIMARY KEY, account_id UUID NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(), event TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
`;

// ---- helpers ----------------------------------------------------------------

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$32768$${salt.toString("base64")}$${key.toString("base64")}`;
}
function checkPassword(password, stored) {
  const [scheme, n, salt, key] = String(stored).split("$");
  if (scheme !== "scrypt") return false;
  const want = Buffer.from(key, "base64");
  const got = crypto.scryptSync(password, Buffer.from(salt, "base64"), want.length, {
    N: Number(n), r: 8, p: 1, maxmem: 128 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(want, got);
}
const safeEqual = (a, b) => {
  const x = Buffer.from(sha256(a)), y = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(x, y);
};

// Pairing codes: 8 characters without look-alikes, shown as XXXX-XXXX.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newPairCode = () =>
  Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
const normalizeCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Fixed-window rate limiter, in memory (one instance).
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  b.n += 1;
  return b.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (status, message) => new HttpError(status, message);

const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

async function readJson(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json"))
    throw bad(415, "Send JSON.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw bad(413, "Too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object") throw new Error();
    return value;
  } catch {
    throw bad(400, "Invalid JSON.");
  }
}

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cache-Control": "no-store",
};

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(payload);
}

const cookieOf = (req, name) =>
  String(req.headers.cookie || "")
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === name)?.[1];
const sessionCookie = (token, maxAge) =>
  `nx_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

const audit = (accountId, event, detail = "") =>
  db.query("INSERT INTO audit (account_id, event, detail) VALUES ($1, $2, $3)", [accountId, event, detail.slice(0, 300)]);

/** Browser session. State-changing requests must also carry a custom header,
 *  which a cross-site form or link cannot add. */
async function requireUser(req) {
  if (req.method !== "GET" && req.headers["x-nexus-web"] !== "1") throw bad(403, "Missing request header.");
  const token = cookieOf(req, "nx_session");
  if (!token) throw bad(401, "Sign in first.");
  const { rows } = await db.query(
    `SELECT a.id, a.email FROM web_session s JOIN account a ON a.id = s.account_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!rows[0]) throw bad(401, "Sign in first.");
  return { ...rows[0], tokenHash: sha256(token) };
}

/** A linked desktop. Revoking a device clears its token, so this fails at once. */
async function requireDevice(req) {
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
  if (!m) throw bad(401, "Device token required.");
  const { rows } = await db.query(
    "SELECT id, account_id, name FROM device WHERE token_hash = $1 AND revoked_at IS NULL",
    [sha256(m[1])],
  );
  if (!rows[0]) throw bad(401, "This device is not linked, or its access was revoked.");
  await db.query("UPDATE device SET last_seen_at = now() WHERE id = $1", [rows[0].id]);
  return rows[0];
}

async function startSession(res, accountId, status, body) {
  const token = newToken();
  await db.query(
    `INSERT INTO web_session (token_hash, account_id, expires_at) VALUES ($1, $2, now() + $3::interval)`,
    [sha256(token), accountId, `${SESSION_DAYS} days`],
  );
  send(res, status, body, { "Set-Cookie": sessionCookie(token, SESSION_DAYS * 86400) });
}

// ---- routes -----------------------------------------------------------------

const routes = {
  "GET /healthz": async (req, res) => {
    await db.query("SELECT 1");
    send(res, 200, { ok: true });
  },

  "POST /api/signup": async (req, res) => {
    if (limited(`signup:${clientIp(req)}`, 5, 3600_000)) throw bad(429, "Too many attempts. Try again later.");
    const { email, password, code } = await readJson(req);
    if (!SIGNUP_CODE || typeof code !== "string" || !safeEqual(code, SIGNUP_CODE))
      throw bad(403, "That sign-up code is not valid.");
    if (!validEmail(email)) throw bad(400, "Enter a valid email address.");
    if (typeof password !== "string" || password.length < 10 || password.length > 200)
      throw bad(400, "Use a password of at least 10 characters.");
    const id = crypto.randomUUID();
    try {
      await db.query("INSERT INTO account (id, email, pw_hash) VALUES ($1, $2, $3)", [
        id, email.toLowerCase(), hashPassword(password),
      ]);
    } catch (err) {
      if (err.code === "23505") throw bad(409, "An account with that email already exists.");
      throw err;
    }
    await audit(id, "account.created");
    await startSession(res, id, 201, { email: email.toLowerCase() });
  },

  "POST /api/login": async (req, res) => {
    const { email, password } = await readJson(req);
    const key = `login:${clientIp(req)}:${String(email).toLowerCase().slice(0, 200)}`;
    if (limited(key, 8, 900_000) || limited(`login:${clientIp(req)}`, 40, 900_000))
      throw bad(429, "Too many attempts. Try again in 15 minutes.");
    const { rows } = await db.query("SELECT id, email, pw_hash FROM account WHERE email = $1", [
      String(email || "").toLowerCase(),
    ]);
    // Hash even when the account does not exist, so timing says nothing.
    const ok = rows[0]
      ? checkPassword(String(password || ""), rows[0].pw_hash)
      : (hashPassword(String(password || "")), false);
    if (!ok) throw bad(401, "Wrong email or password.");
    await audit(rows[0].id, "web.signed_in");
    await startSession(res, rows[0].id, 200, { email: rows[0].email });
  },

  "POST /api/logout": async (req, res) => {
    const user = await requireUser(req);
    await db.query("DELETE FROM web_session WHERE token_hash = $1", [user.tokenHash]);
    send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  },

  // Everything the browser shows, in one read.
  "GET /api/overview": async (req, res) => {
    const user = await requireUser(req);
    const devices = await db.query(
      `SELECT d.id, d.name, d.platform, d.created_at, d.last_seen_at, d.revoked_at,
              s.payload, s.updated_at AS synced_at
       FROM device d LEFT JOIN device_state s ON s.device_id = d.id
       WHERE d.account_id = $1 ORDER BY d.created_at`,
      [user.id],
    );
    const events = await db.query(
      "SELECT ts, event, detail FROM audit WHERE account_id = $1 ORDER BY id DESC LIMIT 30",
      [user.id],
    );
    const now = Date.now();
    send(res, 200, {
      email: user.email,
      serverTime: now,
      devices: devices.rows.map((d) => {
        const seen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : null;
        const age = seen == null ? Infinity : now - seen;
        return {
          id: d.id,
          name: d.name,
          platform: d.platform,
          linkedAt: new Date(d.created_at).getTime(),
          lastSeenAt: seen,
          syncedAt: d.synced_at ? new Date(d.synced_at).getTime() : null,
          // online: heard from within 5 min; stale: within a day; else offline.
          status: d.revoked_at ? "revoked" : age < 300_000 ? "online" : age < 86_400_000 ? "stale" : "offline",
          state: d.revoked_at ? null : d.payload,
        };
      }),
      audit: events.rows.map((e) => ({ ts: new Date(e.ts).getTime(), event: e.event, detail: e.detail })),
    });
  },

  "POST /api/devices/pair-code": async (req, res) => {
    const user = await requireUser(req);
    if (limited(`pair:${user.id}`, 10, 3600_000)) throw bad(429, "Too many codes. Try again later.");
    const code = newPairCode();
    await db.query("DELETE FROM pair_code WHERE account_id = $1 OR expires_at < now()", [user.id]);
    await db.query(
      "INSERT INTO pair_code (code_hash, account_id, expires_at) VALUES ($1, $2, now() + $3::interval)",
      [sha256(code), user.id, `${PAIR_MINUTES} minutes`],
    );
    send(res, 201, { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresInSeconds: PAIR_MINUTES * 60 });
  },

  // Called by the desktop with a code the signed-in user read off the web page.
  "POST /api/devices/claim": async (req, res) => {
    if (limited(`claim:${clientIp(req)}`, 10, 900_000)) throw bad(429, "Too many attempts. Try again later.");
    const { code, name, platform } = await readJson(req);
    const used = await db.query(
      "DELETE FROM pair_code WHERE code_hash = $1 AND expires_at > now() RETURNING account_id",
      [sha256(normalizeCode(code))],
    );
    if (!used.rows[0]) throw bad(403, "That code is wrong or has expired. Get a new one from the web page.");
    const token = newToken();
    const id = crypto.randomUUID();
    const deviceName = (typeof name === "string" && name.trim().slice(0, 80)) || "Desktop";
    await db.query(
      "INSERT INTO device (id, account_id, name, platform, token_hash, last_seen_at) VALUES ($1, $2, $3, $4, $5, now())",
      [id, used.rows[0].account_id, deviceName, String(platform || "").slice(0, 20), sha256(token)],
    );
    await audit(used.rows[0].account_id, "device.linked", deviceName);
    send(res, 201, { deviceId: id, token, name: deviceName });
  },

  "POST /api/devices/revoke": async (req, res) => {
    const user = await requireUser(req);
    const { id } = await readJson(req);
    const r = await db.query(
      `UPDATE device SET revoked_at = now(), token_hash = NULL
       WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL RETURNING name`,
      [String(id), user.id],
    );
    if (!r.rows[0]) throw bad(404, "No such device.");
    await db.query("DELETE FROM device_state WHERE device_id = $1", [String(id)]);
    await audit(user.id, "device.revoked", r.rows[0].name);
    send(res, 200, { ok: true });
  },

  "POST /api/devices/forget": async (req, res) => {
    const user = await requireUser(req);
    const { id } = await readJson(req);
    await db.query("DELETE FROM device WHERE id = $1 AND account_id = $2 AND revoked_at IS NOT NULL", [
      String(id), user.id,
    ]);
    send(res, 200, { ok: true });
  },

  "POST /api/account/delete-data": async (req, res) => {
    const user = await requireUser(req);
    await db.query(
      "DELETE FROM device_state WHERE device_id IN (SELECT id FROM device WHERE account_id = $1)",
      [user.id],
    );
    await audit(user.id, "data.deleted", "All synced data removed from the web");
    send(res, 200, { ok: true });
  },

  "POST /api/account/delete": async (req, res) => {
    const user = await requireUser(req);
    const { password } = await readJson(req);
    const { rows } = await db.query("SELECT pw_hash FROM account WHERE id = $1", [user.id]);
    if (!rows[0] || !checkPassword(String(password || ""), rows[0].pw_hash)) throw bad(403, "Wrong password.");
    await db.query("DELETE FROM account WHERE id = $1", [user.id]);
    send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  },

  // ---- device API ----

  "GET /api/sync/me": async (req, res) => {
    const device = await requireDevice(req);
    const { rows } = await db.query("SELECT revision, updated_at FROM device_state WHERE device_id = $1", [device.id]);
    send(res, 200, {
      deviceId: device.id,
      name: device.name,
      revision: rows[0] ? Number(rows[0].revision) : 0,
    });
  },

  // Replace this device's published state. Idempotent: a retry of the same
  // revision, or an older one arriving late, changes nothing.
  "PUT /api/sync/state": async (req, res) => {
    const device = await requireDevice(req);
    if (limited(`sync:${device.id}`, 120, 600_000)) throw bad(429, "Syncing too often.");
    const { revision, state } = await readJson(req);
    if (!Number.isSafeInteger(revision) || revision < 1) throw bad(400, "Bad revision.");
    const r = await db.query(
      `INSERT INTO device_state (device_id, revision, payload) VALUES ($1, $2, $3)
       ON CONFLICT (device_id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload, updated_at = now()
       WHERE device_state.revision < excluded.revision RETURNING revision`,
      [device.id, revision, JSON.stringify(sanitizeState(state))],
    );
    send(res, 200, { applied: r.rowCount === 1 });
  },

  "DELETE /api/sync/state": async (req, res) => {
    const device = await requireDevice(req);
    await db.query("DELETE FROM device_state WHERE device_id = $1", [device.id]);
    await audit(device.account_id, "data.deleted", `From ${device.name}`);
    send(res, 200, { ok: true });
  },

  // The desktop unlinks itself.
  "DELETE /api/sync/me": async (req, res) => {
    const device = await requireDevice(req);
    await db.query("DELETE FROM device WHERE id = $1", [device.id]);
    await audit(device.account_id, "device.unlinked", device.name);
    send(res, 200, { ok: true });
  },
};

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) return await handler(req, res);
    const file = req.method === "GET" && STATIC[url.pathname];
    if (file) {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": file[1] });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, file[0])));
    }
    send(res, 404, { error: "Not found." });
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(`${req.method} ${url.pathname} failed: ${err.message}`);
    send(res, 500, { error: "Something went wrong on the server." });
  }
});

await db.query(SCHEMA);
server.listen(PORT, () => console.log(`nexus-cloud listening on ${PORT}`));
