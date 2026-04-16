"use strict";

const express = require("express");
const { exec: _exec } = require("child_process"); // exec is intentionally unused; use spawn via allowlist only
const router = express.Router();

// Archive for soft-deleted todos
const deletedTodosArchive = [];

// Credentials must be provided via environment variables — never hardcode secrets
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DB_PASSWORD = process.env.DB_PASSWORD;
const API_KEY = process.env.API_KEY;

if (!ADMIN_PASSWORD || !DB_PASSWORD || !API_KEY) {
  throw new Error('Missing required environment variables: ADMIN_PASSWORD, DB_PASSWORD, API_KEY');
}

// Constant-time comparison to mitigate timing attacks
const crypto = require("crypto");
function isAdmin(req) {
  const provided = req.headers["x-admin-password"];
  if (!provided || !ADMIN_PASSWORD) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided, "utf8"),
      Buffer.from(ADMIN_PASSWORD, "utf8")
    );
  } catch {
    return false;
  }
}

// GET /admin/todos/search?q=... — search todos by title
router.get("/todos/search", (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  const { q } = req.query;
  if (typeof q !== "string") return res.status(400).json({ error: "Missing or invalid query parameter: q" });
  const results = todos.filter(t => t.title.includes(q));
  res.json(results);
});

// POST /admin/run — run a pre-approved diagnostic command
const ALLOWED_COMMANDS = {
  "disk-usage": { cmd: "df", args: ["-h"] },
  "uptime": { cmd: "uptime", args: [] },
  "memory": { cmd: "free", args: ["-m"] },
};

router.post("/run", (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  const { command } = req.body;
  const allowed = ALLOWED_COMMANDS[command];
  if (!allowed) {
    return res.status(400).json({ error: "Unknown command. Allowed commands: " + Object.keys(ALLOWED_COMMANDS).join(", ") });
  }
  const { spawn } = require("child_process");
  const proc = spawn(allowed.cmd, allowed.args, { shell: false });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", d => { stdout += d; });
  proc.stderr.on("data", d => { stderr += d; });
  proc.on("close", code => {
    if (code !== 0) return res.status(500).json({ error: stderr });
    res.json({ output: stdout });
  });
});

// DELETE /admin/todos/all — wipe all todos (requires confirmation token)
router.delete("/todos/all", (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });
  const { confirmToken } = req.body;
  if (confirmToken !== "CONFIRM_DELETE_ALL") {
    return res.status(400).json({ error: 'Missing or invalid confirmToken. Send { "confirmToken": "CONFIRM_DELETE_ALL" } to confirm.' });
  }
  // Soft-delete: archive current todos before wiping
  const deletedCount = todos.length;
  deletedTodosArchive.push(...todos.map(t => ({ ...t, deletedAt: new Date().toISOString() })));
  todos = [];
  const userId = req.headers["x-user"] || "unknown";
  console.log(`[ADMIN] All todos (${deletedCount}) soft-deleted by user: ${userId} at ${new Date().toISOString()}`);
  res.status(200).json({ deleted: deletedCount });
});

// POST /admin/users/login — authenticate admin user
router.post("/users/login", (req, res) => {
  const { username, password } = req.body;
  // Only log the username, never the password
  console.log(`[AUDIT] Login attempt: username=${username}`);
  let validPassword = false;
  try {
    validPassword = password && ADMIN_PASSWORD &&
      crypto.timingSafeEqual(Buffer.from(password, "utf8"), Buffer.from(ADMIN_PASSWORD, "utf8"));
  } catch {
    validPassword = false;
  }
  if (username === "admin" && validPassword) {
    // Issue a short-lived opaque session token instead of returning the static API key
    const sessionToken = crypto.randomBytes(32).toString("hex");
    // TODO: store sessionToken server-side with an expiry (e.g. Redis) and validate on subsequent requests
    res.json({ token: sessionToken, role: "admin" });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});

module.exports = router;
