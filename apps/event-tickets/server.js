import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import QRCode from "qrcode";
import { mountAppCore, inkressApi, createInkressOrder, getInkressOrder, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";
import { sendEmail, sesConfigured } from "@inkress/apps-core/ses";
import { putObject, storageConfigured, decodeDataUrl, isAllowedImage } from "@inkress/apps-core/storage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";
const SIGN_KEY = WEBHOOK_SECRET || process.env.OAUTH_CLIENT_SECRET || "evt-sign";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[event-tickets] Missing env: ${k}`); process.exit(1); }
}

const db = await openPg("event_tickets", `
  CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    name TEXT NOT NULL, blurb TEXT, event_date DATE, venue TEXT,
    price NUMERIC NOT NULL, capacity INTEGER, currency TEXT NOT NULL DEFAULT 'JMD', active BOOLEAN NOT NULL DEFAULT true,
    merchant_name TEXT, merchant_logo TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE events ADD COLUMN IF NOT EXISTS accent TEXT NOT NULL DEFAULT '#6741d9';
  ALTER TABLE events ADD COLUMN IF NOT EXISTS image TEXT;
  ALTER TABLE events ADD COLUMN IF NOT EXISTS tiers JSONB NOT NULL DEFAULT '[]';
  CREATE TABLE IF NOT EXISTS tickets (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, event_id BIGINT NOT NULL,
    code TEXT NOT NULL, holder_name TEXT, holder_email TEXT, qty INTEGER NOT NULL DEFAULT 1, amount NUMERIC, currency TEXT,
    ref TEXT, inkress_order_id TEXT, payment_url TEXT, state TEXT NOT NULL DEFAULT 'awaiting', checked_in_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (merchant_id, code)
  );
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tier_name TEXT;
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS admissions JSONB NOT NULL DEFAULT '[]';
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS refunded BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE tickets ADD COLUMN IF NOT EXISTS comp BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX IF NOT EXISTS idx_et_tickets ON tickets (merchant_id, event_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS webhook_subs (merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_seen (webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);

const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => { tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
const tokens = await openMerchantTokens("event_tickets", core.cfg);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PUBLIC_BASE = (req) => process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
function rand(n = 4) { return crypto.randomBytes(n).toString("hex").toUpperCase(); }
function genCode() { return `TKT-${rand(3)}`; }
const sigOf = (s) => crypto.createHmac("sha256", SIGN_KEY).update(s).digest("hex").slice(0, 8).toUpperCase();
function genAdmissions(qty) { const a = []; for (let i = 0; i < qty; i++) { const code = `ADM-${rand(4)}`; a.push({ code, sig: sigOf(code), checked_in_at: null }); } return a; }
function admissionToken(adm) { return `${adm.code}.${adm.sig}`; }
async function qrDataUrl(text) { try { return await QRCode.toDataURL(text, { margin: 1, width: 240, errorCorrectionLevel: "M" }); } catch { return ""; } }

const tiersOf = (e) => { const t = Array.isArray(e.tiers) ? e.tiers : []; return t.length ? t : [{ name: "General Admission", price: Number(e.price), capacity: e.capacity }]; };
async function eventStats(eventId) {
  const r = await db.q(`SELECT qty, state, admissions FROM tickets WHERE event_id=$1 AND refunded=false`, [eventId]);
  let sold = 0, checked = 0;
  for (const t of r) { if (t.state !== "awaiting") sold += Number(t.qty); checked += (t.admissions || []).filter((a) => a.checked_in_at).length; }
  return { sold, checked_in: checked, awaiting: r.filter((t) => t.state === "awaiting").length };
}
const serializeEvent = (e, stats, req) => ({ id: e.id, name: e.name, blurb: e.blurb, event_date: e.event_date, venue: e.venue, price: Number(e.price), capacity: e.capacity, currency: e.currency, active: e.active, accent: e.accent, image: e.image, tiers: tiersOf(e), sold: stats?.sold || 0, checked_in: stats?.checked_in || 0, public_url: `${PUBLIC_BASE(req)}/event/${e.id}` });
const serializeTicket = (t) => ({ id: t.id, code: t.code, holder_name: t.holder_name, holder_email: t.holder_email, qty: Number(t.qty), amount: Number(t.amount), currency: t.currency, state: t.state, tier_name: t.tier_name, comp: t.comp, refunded: t.refunded, admissions: (t.admissions || []).map((a) => ({ code: a.code, checked_in_at: a.checked_in_at })), checked_in_count: (t.admissions || []).filter((a) => a.checked_in_at).length, created_at: t.created_at });

// ---- Events ----------------------------------------------------------------
app.get("/api/events", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM events WHERE merchant_id=$1 ORDER BY id DESC`, [req.session.merchantId]);
  const out = []; for (const e of rows) out.push(serializeEvent(e, await eventStats(e.id), req));
  res.json({ events: out, connected: await tokens.hasToken(req.session.merchantId), webhook_realtime: Boolean(WEBHOOK_SECRET), storage: storageConfigured() });
});
function eventFields(b, e) {
  const tiers = Array.isArray(b.tiers) ? b.tiers.map((t) => ({ name: String(t.name || "Tier").slice(0, 40), price: round2(t.price), capacity: t.capacity ? Number(t.capacity) : null })).filter((t) => t.name && t.price >= 0) : (e?.tiers || []);
  return {
    name: String(b.name ?? e?.name ?? "").trim(), blurb: b.blurb !== undefined ? (b.blurb || null) : (e?.blurb ?? null),
    event_date: b.event_date !== undefined ? (/^\d{4}-\d{2}-\d{2}$/.test(b.event_date) ? b.event_date : null) : (e?.event_date ?? null),
    venue: b.venue !== undefined ? (b.venue || null) : (e?.venue ?? null), price: b.price != null ? round2(b.price) : Number(e?.price ?? 0),
    capacity: b.capacity !== undefined ? (b.capacity ? Number(b.capacity) : null) : (e?.capacity ?? null),
    accent: /^#[0-9a-fA-F]{6}$/.test(b.accent) ? b.accent : (e?.accent || "#6741d9"), image: b.image !== undefined ? (b.image || null) : (e?.image ?? null), tiers,
  };
}
app.post("/api/events", core.requireSession, async (req, res) => {
  const b = req.body || {}; const m = req.session.data?.merchant || {}; const f = eventFields(b);
  if (!f.name || !(f.price >= 0)) return res.status(400).json({ error: "bad_input", message: "Event name and ticket price are required." });
  const row = await db.one(`INSERT INTO events (merchant_id, name, blurb, event_date, venue, price, capacity, accent, image, tiers, currency, merchant_name, merchant_logo)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [req.session.merchantId, f.name, f.blurb, f.event_date, f.venue, f.price, f.capacity, f.accent, f.image, JSON.stringify(f.tiers), m.currency_code || "JMD", m.name || null, m.logo || m.logo_url || null]);
  res.status(201).json({ event: serializeEvent(row, { sold: 0, checked_in: 0 }, req) });
});
app.patch("/api/events/:id", core.requireSession, async (req, res) => {
  const e = await db.one(`SELECT * FROM events WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!e) return res.status(404).json({ error: "not_found" });
  const b = req.body || {}; const f = eventFields(b, e);
  const u = await db.one(`UPDATE events SET name=$1, blurb=$2, event_date=$3, venue=$4, price=$5, capacity=$6, accent=$7, image=$8, tiers=$9, active=$10 WHERE id=$11 RETURNING *`,
    [f.name, f.blurb, f.event_date, f.venue, f.price, f.capacity, f.accent, f.image, JSON.stringify(f.tiers), b.active != null ? !!b.active : e.active, e.id]);
  res.json({ event: serializeEvent(u, await eventStats(e.id), req) });
});
app.delete("/api/events/:id", core.requireSession, async (req, res) => {
  await db.run(`DELETE FROM tickets WHERE event_id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  await db.run(`DELETE FROM events WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

// Poster upload (S3)
app.post("/api/upload", core.requireSession, async (req, res) => {
  if (!storageConfigured()) return res.status(503).json({ error: "storage_off", message: "Image hosting isn't configured — paste an image URL." });
  const decoded = decodeDataUrl(req.body?.data);
  if (!decoded || !isAllowedImage(decoded.contentType)) return res.status(400).json({ error: "bad_image", message: "Upload a JPG, PNG, WEBP or GIF." });
  if (decoded.body.length > 5 * 1024 * 1024) return res.status(400).json({ error: "too_big", message: "Image must be under 5MB." });
  try { const { url } = await putObject({ prefix: `event-tickets/${req.session.merchantId}`, body: decoded.body, contentType: decoded.contentType }); res.json({ url }); }
  catch (err) { res.status(502).json({ error: "upload_failed", message: err?.message }); }
});

// ---- Tickets + door --------------------------------------------------------
app.get("/api/events/:id/tickets", core.requireSession, async (req, res) => {
  if (req.query.refresh === "1" && !WEBHOOK_SECRET) await pollAwaiting(req.session.merchantId, req.session.accessToken, req.params.id);
  let rows = await db.q(`SELECT * FROM tickets WHERE event_id=$1 AND merchant_id=$2 ORDER BY created_at DESC`, [req.params.id, req.session.merchantId]);
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q) rows = rows.filter((t) => (`${t.holder_name || ""} ${t.holder_email || ""} ${t.code}`).toLowerCase().includes(q));
  res.json({ tickets: rows.map(serializeTicket) });
});
app.get("/api/events/:id/scans", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM tickets WHERE event_id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  const scans = [];
  for (const t of rows) for (const a of (t.admissions || [])) if (a.checked_in_at) scans.push({ code: a.code, holder: t.holder_name, tier: t.tier_name, at: a.checked_in_at });
  scans.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ scans: scans.slice(0, 100) });
});
// Check-in — accepts an admission token (ADM-x.sig), a bare admission code, or a ticket code.
app.post("/api/tickets/checkin", core.requireSession, async (req, res) => {
  const raw = String(req.body?.code || "").trim().toUpperCase();
  if (!raw) return res.json({ found: false });
  const [adm, sig] = raw.split(".");
  // admission-level
  let ticket = await db.one(`SELECT * FROM tickets WHERE merchant_id=$1 AND admissions @> $2::jsonb`, [req.session.merchantId, JSON.stringify([{ code: adm }])]).catch(() => null);
  if (ticket) {
    if (sig && sigOf(adm) !== sig) return res.json({ found: true, ticket: serializeTicket(ticket), warning: "bad_signature" });
    if (ticket.state === "awaiting") return res.json({ found: true, ticket: serializeTicket(ticket), warning: "not_paid" });
    if (ticket.refunded) return res.json({ found: true, ticket: serializeTicket(ticket), warning: "refunded" });
    const admissions = ticket.admissions.map((a) => ({ ...a }));
    const target = admissions.find((a) => a.code === adm);
    if (target.checked_in_at) return res.json({ found: true, ticket: serializeTicket(ticket), warning: "already", admission: adm });
    target.checked_in_at = new Date().toISOString();
    const allIn = admissions.every((a) => a.checked_in_at);
    const u = await db.one(`UPDATE tickets SET admissions=$1, state=$2, checked_in_at=COALESCE(checked_in_at, now()) WHERE id=$3 RETURNING *`, [JSON.stringify(admissions), allIn ? "checked_in" : ticket.state === "checked_in" ? "checked_in" : "active", ticket.id]);
    return res.json({ found: true, ticket: serializeTicket(u), checked_in: true, admission: adm, remaining: admissions.filter((a) => !a.checked_in_at).length });
  }
  // ticket-level (legacy / manual whole-ticket check-in)
  ticket = await db.one(`SELECT * FROM tickets WHERE merchant_id=$1 AND code=$2`, [req.session.merchantId, adm]).catch(() => null);
  if (!ticket) return res.json({ found: false });
  if (ticket.state === "awaiting") return res.json({ found: true, ticket: serializeTicket(ticket), warning: "not_paid" });
  const admissions = (ticket.admissions || []).map((a) => ({ ...a, checked_in_at: a.checked_in_at || new Date().toISOString() }));
  const u = await db.one(`UPDATE tickets SET state='checked_in', checked_in_at=now(), admissions=$2 WHERE id=$1 RETURNING *`, [ticket.id, JSON.stringify(admissions)]);
  res.json({ found: true, ticket: serializeTicket(u), checked_in: true });
});

// Comp (free) ticket — issued active immediately + emailed
app.post("/api/events/:id/comp", core.requireSession, async (req, res) => {
  const e = await db.one(`SELECT * FROM events WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!e) return res.status(404).json({ error: "not_found" });
  const b = req.body || {}; const qty = Math.max(1, Math.min(20, Number(b.qty) || 1));
  const row = await db.one(`INSERT INTO tickets (merchant_id, event_id, code, holder_name, holder_email, qty, amount, currency, tier_name, state, comp, admissions)
    VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,'active',true,$9) RETURNING *`,
    [req.session.merchantId, e.id, genCode(), b.name || "Guest", String(b.email || "").trim().toLowerCase() || null, qty, e.currency, b.tier_name || "Comp", JSON.stringify(genAdmissions(qty))]);
  emailTicket(row).catch(() => {});
  res.status(201).json({ ticket: serializeTicket(row) });
});
app.post("/api/tickets/:id/resend", core.requireSession, async (req, res) => {
  const t = await db.one(`SELECT * FROM tickets WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!t) return res.status(404).json({ error: "not_found" });
  if (!sesConfigured()) return res.json({ sent: false });
  await emailTicket(t); res.json({ sent: true });
});
app.patch("/api/tickets/:id", core.requireSession, async (req, res) => {
  const t = await db.one(`SELECT * FROM tickets WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!t) return res.status(404).json({ error: "not_found" });
  if (req.body?.refunded === true) { const u = await db.one(`UPDATE tickets SET refunded=true, state='refunded' WHERE id=$1 RETURNING *`, [t.id]); return res.json({ ticket: serializeTicket(u) }); }
  res.status(400).json({ error: "unsupported" });
});

app.get("/api/events/:id/analytics", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM tickets WHERE event_id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  const paid = rows.filter((t) => t.state !== "awaiting" && !t.refunded);
  const byTier = {};
  let revenue = 0, admissions = 0, checked = 0;
  for (const t of paid) { revenue += Number(t.amount || 0); admissions += Number(t.qty); checked += (t.admissions || []).filter((a) => a.checked_in_at).length; const k = t.tier_name || "General"; byTier[k] = byTier[k] || { tier: k, sold: 0, revenue: 0 }; byTier[k].sold += Number(t.qty); byTier[k].revenue = round2(byTier[k].revenue + Number(t.amount || 0)); }
  res.json({ revenue: round2(revenue), tickets: paid.length, admissions, checked_in: checked, checkin_rate: admissions ? Math.round((checked / admissions) * 100) : 0, awaiting: rows.filter((t) => t.state === "awaiting").length, by_tier: Object.values(byTier).sort((a, b) => b.revenue - a.revenue) });
});
app.get("/api/events/:id/attendees.csv", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM tickets WHERE event_id=$1 AND merchant_id=$2 ORDER BY created_at DESC`, [req.params.id, req.session.merchantId]);
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((t) => [t.code, t.holder_name, t.holder_email, t.tier_name || "", t.qty, t.state, (t.admissions || []).filter((a) => a.checked_in_at).length, t.comp ? "comp" : "", t.amount].map(esc).join(","));
  res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", `attachment; filename="attendees.csv"`);
  res.send(["code,name,email,tier,qty,state,checked_in,comp,amount", ...lines].join("\n"));
});

app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const url = `${PUBLIC_BASE(req)}/webhooks/inkress/${mid}`;
    try { await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) }); await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2`, [mid, url]); sub = { merchant_id: mid, url }; }
    catch (err) { if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]); sub = { merchant_id: mid, url }; } }
  }
  res.json({ realtime: Boolean(sub) && Boolean(WEBHOOK_SECRET), webhook_registered: Boolean(sub), wallet_passes: false });
});

// ---- Public buy + activation ----------------------------------------------
app.get("/event/:id", async (req, res) => {
  const e = await db.one(`SELECT * FROM events WHERE id=$1`, [req.params.id]).catch(() => null);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!e || !e.active) return res.status(404).send(publicShell("Unavailable", `<div class="pad"><h1>Tickets unavailable</h1></div>`));
  res.send(buyPage(e, await eventStats(e.id)));
});
app.post("/api/public/event/:id", express.json(), async (req, res) => {
  const e = await db.one(`SELECT * FROM events WHERE id=$1`, [req.params.id]).catch(() => null);
  if (!e || !e.active) return res.status(404).json({ error: "closed" });
  const qty = Math.max(1, Math.min(10, Math.floor(Number(req.body?.qty) || 1)));
  const tiers = tiersOf(e); const tier = tiers.find((t) => t.name === req.body?.tier) || tiers[0];
  if (e.capacity) { const s = await eventStats(e.id); if (s.sold + qty > e.capacity) return res.status(400).json({ error: "sold_out", message: "Not enough tickets left." }); }
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "bad_email", message: "Enter a valid email." });
  let accessToken;
  try { accessToken = await tokens.accessTokenFor(e.merchant_id); } catch { return res.status(503).json({ error: "not_connected", message: "This organiser hasn't finished setup." }); }
  const total = round2(Number(tier.price) * qty);
  const ref = `ticket-${e.merchant_id}-${e.id}-${Date.now().toString(36)}-${rand(2)}`;
  const name = String(req.body?.name || "Guest").trim();
  const [first, ...rest] = name.split(/\s+/);
  let created;
  try {
    created = await createInkressOrder(core.cfg, accessToken, {
      referenceId: ref, total, currencyCode: e.currency, kind: "online", title: `${qty}× ${e.name} (${tier.name})`,
      customer: { email, first_name: first || "Guest", last_name: rest.join(" ") || "" },
      metaData: { source: "event-tickets", event_id: e.id, event: e.name, tier: tier.name, qty },
    });
  } catch (err) { return res.status(502).json({ error: "order_failed", message: err?.message }); }
  await db.run(`INSERT INTO tickets (merchant_id, event_id, code, holder_name, holder_email, qty, amount, currency, tier_name, ref, inkress_order_id, payment_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [e.merchant_id, e.id, genCode(), name, email, qty, total, e.currency, tier.name, ref, created.id != null ? String(created.id) : null, created.payment_url || null]);
  res.json({ payment_url: created.payment_url });
});

async function activateTicket(t) {
  const admissions = (t.admissions && t.admissions.length) ? t.admissions : genAdmissions(Number(t.qty) || 1);
  const u = await db.one(`UPDATE tickets SET state='active', admissions=$2 WHERE id=$1 RETURNING *`, [t.id, JSON.stringify(admissions)]);
  emailTicket(u).catch(() => {});
}
async function pollAwaiting(mid, accessToken, eventId) {
  const awaiting = await db.q(`SELECT * FROM tickets WHERE event_id=$1 AND merchant_id=$2 AND state='awaiting' AND inkress_order_id IS NOT NULL LIMIT 25`, [eventId, mid]);
  for (const t of awaiting) { try { const ink = await getInkressOrder(core.cfg, accessToken, t.inkress_order_id); if (ink && isPaidStatus(ink)) await activateTicket(t); } catch { /* */ } }
}

app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });
  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId || String(o.status || "").toLowerCase() !== "paid") return;
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);
    const t = await db.one(`SELECT * FROM tickets WHERE merchant_id=$1 AND inkress_order_id=$2 AND state='awaiting'`, [merchantId, String(o.id)]);
    if (t) await activateTicket(t);
  } catch (err) { console.error(`[event-tickets] webhook failed: ${err?.message}`); }
});

async function emailTicket(t) {
  if (!sesConfigured() || !t.holder_email) return;
  const e = await db.one(`SELECT * FROM events WHERE id=$1`, [t.event_id]).catch(() => null);
  await sendEmail({ to: t.holder_email, subject: `🎟 Your ticket for ${e?.name || "the event"}`, html: await ticketEmail(e, t) });
}

app.get("/t/:code", async (req, res) => {
  const t = await db.one(`SELECT * FROM tickets WHERE code=$1`, [String(req.params.code || "").toUpperCase()]).catch(() => null);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!t) return res.status(404).send(publicShell("Not found", `<div class="pad"><h1>Ticket not found</h1></div>`));
  const e = await db.one(`SELECT * FROM events WHERE id=$1`, [t.event_id]).catch(() => null);
  res.send(await ticketPage(e, t));
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[event-tickets] listening on ${HOST}:${PORT}`));

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function money(n, c) { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency: c }).format(n); } catch { return `${c} ${n}`; } }
async function ticketEmail(e, t) {
  const accent = (e?.accent && /^#[0-9a-fA-F]{6}$/.test(e.accent)) ? e.accent : "#6741d9";
  const adms = (t.admissions || []).length ? t.admissions : [{ code: t.code, sig: sigOf(t.code) }];
  const qrs = []; for (const a of adms) qrs.push(`<div style="display:inline-block;margin:6px;text-align:center"><img src="${await qrDataUrl(admissionToken(a))}" width="150" height="150" style="border-radius:10px;border:1px solid #eee"><div style="font-family:ui-monospace,monospace;font-size:13px;margin-top:4px">${esc(a.code)}</div></div>`);
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;text-align:center;color:#1a1a1a;">
    ${e?.image ? `<img src="${esc(e.image)}" style="width:100%;max-height:160px;object-fit:cover;border-radius:12px;margin-bottom:10px">` : `<div style="font-size:40px;">🎟</div>`}
    <h2 style="margin:4px 0;">${esc(e?.name || "Your ticket")}</h2>
    ${e?.event_date ? `<p style="color:#555;">${esc(e.event_date)}${e.venue ? ` · ${esc(e.venue)}` : ""}</p>` : ""}
    <p style="color:#666;font-size:13px;">${t.qty}× ${esc(t.tier_name || "admission")} — scan each QR at the door</p>
    <div>${qrs.join("")}</div>
    <p style="color:#aaa;font-size:12px;">via Marketplace</p></div>`;
}
async function ticketPage(e, t) {
  const accent = (e?.accent && /^#[0-9a-fA-F]{6}$/.test(e.accent)) ? e.accent : "#6741d9";
  const adms = (t.admissions || []).length ? t.admissions : [{ code: t.code, sig: sigOf(t.code), checked_in_at: t.checked_in_at }];
  const cards = []; for (const a of adms) cards.push(`<div style="margin:14px 0;text-align:center"><img src="${await qrDataUrl(admissionToken(a))}" width="220" height="220" style="border-radius:12px;border:1px solid #eee"><div style="font-family:ui-monospace,monospace;font-weight:700;letter-spacing:.06em;margin-top:6px">${esc(a.code)}</div>${a.checked_in_at ? `<div style="color:#2f9e44;font-weight:600;font-size:.85rem">Checked in ✓</div>` : ""}</div>`);
  return publicShell(`Ticket ${t.code}`, `<div class="pad" style="text-align:center">
    <h1>${esc(e?.name || "Your ticket")}</h1>
    <p class="blurb">${e?.event_date ? esc(e.event_date) : ""}${e?.venue ? ` · ${esc(e.venue)}` : ""} · ${esc(t.tier_name || "")}</p>
    ${t.state === "awaiting" ? `<p class="blurb" style="color:#b8860b">Awaiting payment</p>` : cards.join("")}</div>`, accent);
}
function publicShell(title, inner, accent = "#6741d9") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f6f7f9;color:#1f2430;display:grid;place-items:center;min-height:100vh;padding:20px}
  .card{background:#fff;border:1px solid #e9ebef;border-radius:18px;box-shadow:0 14px 44px rgba(20,25,40,.12);max-width:440px;width:100%;overflow:hidden}
  .accent{height:4px;background:${accent}} .pad{padding:26px}
  .poster{width:100%;height:170px;object-fit:cover;display:block}
  .logo{width:60px;height:60px;border-radius:16px;object-fit:cover;margin:0 auto 12px;display:block;border:1px solid #eee}
  h1{font-size:1.5rem;margin:0 0 6px;text-align:center} .blurb{color:#6b7280;text-align:center;margin:0 0 14px}
  .price{text-align:center;font-size:2rem;font-weight:800;margin:4px 0 4px}
  .tiers{display:flex;flex-direction:column;gap:8px;margin:8px 0 12px}.tier{display:flex;justify-content:space-between;align-items:center;padding:11px 14px;border:1px solid #d4d8df;border-radius:10px;cursor:pointer}.tier.sel{border-color:${accent};background:#f1eefc}.tier b{font-weight:700}
  .qty{display:flex;align-items:center;justify-content:center;gap:14px;margin:12px 0}.qty button{width:38px;height:38px;border-radius:10px;border:1px solid #d4d8df;background:#fff;font-size:20px;cursor:pointer;color:#333}.qty b{min-width:30px;text-align:center;font-size:18px}
  input{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d4d8df;border-radius:10px;font-size:15px;margin-bottom:10px}
  button.buy{width:100%;padding:14px;border:0;border-radius:10px;background:${accent};color:#fff;font-size:15px;font-weight:700;cursor:pointer}
  .foot{text-align:center;color:#aab;font-size:12px;padding:14px}</style></head>
  <body><div class="card"><div class="accent"></div>${inner}<div class="foot">powered by Marketplace</div></div></body></html>`;
}
function buyPage(e, stats) {
  const accent = (e.accent && /^#[0-9a-fA-F]{6}$/.test(e.accent)) ? e.accent : "#6741d9";
  const logo = e.merchant_logo ? `<img class="logo" src="${esc(e.merchant_logo)}" alt="">` : "";
  const left = e.capacity ? Math.max(0, e.capacity - stats.sold) : null;
  const tiers = tiersOf(e);
  const tierHtml = tiers.map((t, i) => `<div class="tier${i === 0 ? " sel" : ""}" data-name="${esc(t.name)}" data-price="${t.price}"><span>${esc(t.name)}</span><b>${esc(money(Number(t.price), e.currency))}</b></div>`).join("");
  return publicShell(`${e.name}`, `${e.image ? `<img class="poster" src="${esc(e.image)}" alt="">` : ""}<div class="pad">${e.image ? "" : logo}
    <h1>${esc(e.name)}</h1>
    <p class="blurb">${e.event_date ? esc(e.event_date) : ""}${e.venue ? ` · ${esc(e.venue)}` : ""}</p>
    ${e.blurb ? `<p class="blurb">${esc(e.blurb)}</p>` : ""}
    <div class="tiers">${tierHtml}</div>
    ${left != null ? `<p class="blurb">${left} of ${e.capacity} left</p>` : ""}
    <div class="qty"><button id="dec">−</button><b id="q">1</b><button id="inc">+</button></div>
    <input id="n" required placeholder="Your name" autocomplete="name">
    <input id="em" type="email" required placeholder="you@email.com" autocomplete="email">
    <button class="buy" id="buy">Buy tickets</button>
    <div id="msg" style="display:none;color:#6b7280;text-align:center;margin-top:10px"></div>
    <script>let q=1,tier=${JSON.stringify(tiers[0]?.name || "")};const qe=document.getElementById('q');document.getElementById('inc').onclick=()=>{q=Math.min(10,q+1);qe.textContent=q;};document.getElementById('dec').onclick=()=>{q=Math.max(1,q-1);qe.textContent=q;};
    document.querySelectorAll('.tier').forEach(el=>el.addEventListener('click',()=>{document.querySelectorAll('.tier').forEach(x=>x.classList.remove('sel'));el.classList.add('sel');tier=el.dataset.name;}));
    document.getElementById('buy').addEventListener('click',async()=>{const n=document.getElementById('n').value,em=document.getElementById('em').value;if(!n||!em){show('Enter your name and email.');return;}const b=document.getElementById('buy');b.disabled=true;b.textContent='Creating your link…';const r=await fetch('/api/public/event/${e.id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({qty:q,tier,name:n,email:em})});const j=await r.json();if(j.payment_url){window.location.href=j.payment_url;}else{b.disabled=false;b.textContent='Buy tickets';show(j.message||'Something went wrong.');}});
    function show(t){const m=document.getElementById('msg');m.style.display='block';m.textContent=t;}</script></div>`, accent);
}
