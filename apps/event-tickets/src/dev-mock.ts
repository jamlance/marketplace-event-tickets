/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

const adm = (n: number, ci = false) => Array.from({ length: n }, (_, i) => ({ code: `ADM-${1000 + i}`, checked_in_at: ci ? new Date().toISOString() : null }));
let EVENTS: any[] = [
  { id: 1, name: "Friday Night Live", blurb: "Live music + open bar.", event_date: "2026-07-18", venue: "The Yard, Kingston", price: 2500, capacity: 200, currency: "JMD", active: true, accent: "#6741d9", image: null, tiers: [{ name: "General", price: 2500, capacity: 150 }, { name: "VIP", price: 6000, capacity: 50 }], sold: 134, checked_in: 0, public_url: location.origin + "/event/1" },
  { id: 2, name: "Sunday Brunch Session", blurb: null, event_date: "2026-06-22", venue: "Rooftop", price: 4000, capacity: 60, currency: "JMD", active: true, accent: "#0a7d54", image: null, tiers: [{ name: "General Admission", price: 4000, capacity: 60 }], sold: 51, checked_in: 12, public_url: location.origin + "/event/2" },
];
let EID = 2;
let TICKETS: any[] = [
  { id: 1, event_id: 1, code: "TKT-A1B2C3", holder_name: "Maria Brown", holder_email: "maria@example.com", qty: 2, amount: 5000, currency: "JMD", state: "active", tier_name: "General", comp: false, refunded: false, admissions: adm(2), checked_in_count: 0, created_at: new Date(Date.now() - 36e5).toISOString() },
  { id: 2, event_id: 1, code: "TKT-D4E5F6", holder_name: "Devon Clarke", holder_email: "devon@example.com", qty: 1, amount: 6000, currency: "JMD", state: "awaiting", tier_name: "VIP", comp: false, refunded: false, admissions: [], checked_in_count: 0, created_at: new Date().toISOString() },
  { id: 3, event_id: 2, code: "TKT-G7H8I9", holder_name: "Aaliyah Wright", holder_email: "aaliyah@example.com", qty: 4, amount: 16000, currency: "JMD", state: "checked_in", tier_name: "General Admission", comp: false, refunded: false, admissions: adm(4, true), checked_in_count: 4, created_at: new Date(Date.now() - 9e7).toISOString() },
];
let TID = 3;

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 80));
    const em = u.pathname.match(/\/api\/events\/(\d+)(\/tickets|\/comp|\/analytics|\/scans|\/attendees\.csv)?$/);
    const tm = u.pathname.match(/\/api\/tickets\/(\d+)(\/resend)?$/);

    if (u.pathname === "/api/events" && method === "GET") return json({ events: EVENTS, connected: true, webhook_realtime: true, storage: true });
    if (u.pathname === "/api/events" && method === "POST") { const e = { id: ++EID, ...body, currency: "JMD", active: true, tiers: body.tiers || [], sold: 0, checked_in: 0, public_url: location.origin + "/event/" + EID }; EVENTS.unshift(e); return json({ event: e }, 201); }
    if (u.pathname === "/api/upload") return json({ url: "https://placehold.co/600x300/png" });
    if (em && em[2] === "/tickets") { let rows = TICKETS.filter((t) => t.event_id === Number(em[1])); const q = (u.searchParams.get("q") || "").toLowerCase(); if (q) rows = rows.filter((t) => (t.holder_name + t.holder_email + t.code).toLowerCase().includes(q)); return json({ tickets: rows }); }
    if (em && em[2] === "/comp") { const e = EVENTS.find((x) => x.id === Number(em[1])); const t = { id: ++TID, event_id: e.id, code: "TKT-CMP" + TID, holder_name: body.name || "Guest", holder_email: body.email, qty: body.qty || 1, amount: 0, currency: "JMD", state: "active", tier_name: body.tier_name || "Comp", comp: true, refunded: false, admissions: adm(body.qty || 1), checked_in_count: 0, created_at: new Date().toISOString() }; TICKETS.unshift(t); return json({ ticket: t }, 201); }
    if (em && em[2] === "/analytics") { const paid = TICKETS.filter((t) => t.event_id === Number(em[1]) && t.state !== "awaiting" && !t.refunded); const byTier: any = {}; let rev = 0, adms = 0, ci = 0; for (const t of paid) { rev += t.amount; adms += t.qty; ci += t.checked_in_count; byTier[t.tier_name] = byTier[t.tier_name] || { tier: t.tier_name, sold: 0, revenue: 0 }; byTier[t.tier_name].sold += t.qty; byTier[t.tier_name].revenue += t.amount; } return json({ revenue: rev, tickets: paid.length, admissions: adms, checked_in: ci, checkin_rate: adms ? Math.round(ci / adms * 100) : 0, awaiting: TICKETS.filter((t) => t.event_id === Number(em[1]) && t.state === "awaiting").length, by_tier: Object.values(byTier) }); }
    if (em && em[2] === "/scans") return json({ scans: [] });
    if (em && em[2] === "/attendees.csv") return new Response("code,name,email,tier\nTKT-A1B2C3,Maria Brown,maria@example.com,General", { status: 200, headers: { "Content-Type": "text/csv" } });
    if (em && method === "PATCH") { const e = EVENTS.find((x) => x.id === Number(em[1])); Object.assign(e, body); return json({ event: e }); }
    if (em && method === "DELETE") { EVENTS = EVENTS.filter((x) => x.id !== Number(em[1])); TICKETS = TICKETS.filter((t) => t.event_id !== Number(em[1])); return json({ ok: true }); }
    if (tm && tm[2] === "/resend") return json({ sent: true });
    if (tm && method === "PATCH") { const t = TICKETS.find((x) => x.id === Number(tm[1])); if (t && body.refunded) { t.refunded = true; t.state = "refunded"; } return json({ ticket: t }); }
    if (u.pathname === "/api/tickets/checkin") { const raw = String(body.code).toUpperCase(); const code = raw.split(".")[0]; let t = TICKETS.find((x) => (x.admissions || []).some((a: any) => a.code === code)); if (t) { if (t.state === "awaiting") return json({ found: true, ticket: t, warning: "not_paid" }); const a = t.admissions.find((x: any) => x.code === code); if (a.checked_in_at) return json({ found: true, ticket: t, warning: "already" }); a.checked_in_at = new Date().toISOString(); t.checked_in_count = t.admissions.filter((x: any) => x.checked_in_at).length; if (t.checked_in_count >= t.qty) t.state = "checked_in"; return json({ found: true, ticket: t, checked_in: true, remaining: t.qty - t.checked_in_count }); } t = TICKETS.find((x) => x.code === code); if (!t) return json({ found: false }); t.state = "checked_in"; t.checked_in_count = t.qty; return json({ found: true, ticket: t, checked_in: true }); }
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "bookerva-jackjack", name: "Jack Jack Barbershop", currency_code: "JMD", email: "jack@example.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@jackjack.com" },
    scopes: ["orders:write", "webhooks:manage", "offline_access"],
  };
}
