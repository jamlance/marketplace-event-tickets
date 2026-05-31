import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, fmtDate, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Tier { name: string; price: number; capacity: number | null; }
interface Event { id: number; name: string; blurb: string | null; event_date: string | null; venue: string | null; price: number; capacity: number | null; currency: string; active: boolean; accent: string; image: string | null; tiers: Tier[]; sold: number; checked_in: number; public_url: string; }
interface Adm { code: string; checked_in_at: string | null; }
interface Ticket { id: number; code: string; holder_name: string | null; holder_email: string | null; qty: number; amount: number; currency: string; state: string; tier_name: string | null; comp: boolean; refunded: boolean; admissions: Adm[]; checked_in_count: number; created_at: string; }
interface Analytics { revenue: number; tickets: number; admissions: number; checked_in: number; checkin_rate: number; awaiting: number; by_tier: { tier: string; sold: number; revenue: number }[]; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let events: Event[] = [];
let ticketEvent = 0;
let canStore = false;
let tSearch = "";
let shell: ReturnType<typeof mountShell>;

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";

  shell = mountShell({
    brandIcon: "ticket", brandLogo: "/logo.svg", title: "Event Tickets",
    subtitle: `${merchantName} · sell tickets, scan at the door`, poweredBy: "Marketplace",
    tabs: [
      { id: "events", label: "Events", icon: "ticket", render: renderEvents },
      { id: "checkin", label: "Check-in", icon: "check", render: renderCheckin },
      { id: "tickets", label: "Tickets", icon: "list", render: renderTickets },
      { id: "analytics", label: "Analytics", icon: "chart", render: renderAnalytics },
    ],
  });
})();

const sidOf = () => sessionStorage.getItem("bv_app_session_id") || localStorage.getItem("bv_app_session_id") || "";

/* -------------------------------------------------------------------- Events */
async function renderEvents(host: HTMLElement) {
  stopScan();
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let data: { events: Event[]; connected: boolean; webhook_realtime: boolean; storage: boolean };
  try { data = await bvApi("/api/events"); events = data.events; canStore = data.storage; }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  host.append(statRow([
    { k: "Events", v: String(events.length), icon: "ticket" },
    { k: "Tickets sold", v: String(events.reduce((s, e) => s + e.sold, 0)), tone: "ok", icon: "users" },
    { k: "Checked in", v: String(events.reduce((s, e) => s + e.checked_in, 0)), tone: "accent", icon: "check" },
  ]));

  const add = h("button", { class: "primary", onClick: () => openEvent(null) }, iconEl("plus", 15), "New event");
  if (!events.length) { host.append(card({ title: "Events", action: add, body: emptyState({ icon: "ticket", title: "No events yet", text: "Create an event and share its link — sell tickets online." }) })); return; }

  const grid = h("div", { class: "et-grid" });
  for (const e of events) {
    const left = e.capacity ? Math.max(0, e.capacity - e.sold) : null;
    grid.append(h("div", { class: "et-card" + (e.active ? "" : " is-off"), style: { "--ac": e.accent } as any },
      e.image ? h("span", { class: "et-poster", style: { backgroundImage: `url('${e.image}')` } }) : h("span", { class: "et-stripe" }),
      h("div", { class: "et-card-body" },
        h("div", { class: "et-card-head" }, h("strong", null, e.name), e.active ? pill("live", "ok") : pill("off")),
        h("div", { class: "bv-muted et-when" }, [e.event_date ? fmtDate(e.event_date) : null, e.venue].filter(Boolean).join(" · ") || "—"),
        h("div", { class: "et-price" }, e.tiers.length > 1 ? `${e.tiers.length} tiers · from ${fmtMoney(Math.min(...e.tiers.map((t) => t.price)), e.currency)}` : fmtMoney(e.price, e.currency)),
        h("div", { class: "et-stats" }, h("span", null, h("b", null, String(e.sold)), " sold"), left != null ? h("span", { class: "bv-muted" }, `${left} left`) : null, h("span", { class: "bv-muted" }, `${e.checked_in} in`)),
        h("div", { class: "et-link" }, h("input", { class: "et-link-input", readonly: true, value: e.public_url }), h("button", { class: "ghost sm", onClick: () => { navigator.clipboard?.writeText(e.public_url); flash("Link copied", "success"); } }, iconEl("copy", 14))),
        h("div", { class: "et-actions" }, h("button", { class: "ghost sm", onClick: () => { ticketEvent = e.id; shell.select("tickets"); } }, "Tickets"), h("a", { class: "et-open", href: e.public_url, target: "_blank", rel: "noopener" }, iconEl("external", 14)), h("button", { class: "ghost sm", onClick: () => openEvent(e) }, iconEl("edit", 14)), h("button", { class: "ghost sm", onClick: async () => { if (confirm(`Delete ${e.name}?`)) { await bvApi(`/api/events/${e.id}`, { method: "DELETE" }); shell.select("events"); } } }, iconEl("trash", 14))))));
  }
  host.append(card({ title: "Events", action: add, body: grid }));
  if (data.webhook_realtime) host.append(h("div", { class: "et-note bv-muted" }, iconEl("check", 14), "Real-time: tickets activate + the QR emails the instant payment lands."));
}

function openEvent(e: Event | null) {
  const name = h("input", { value: e?.name || "", placeholder: "e.g. Friday Night Live" }) as HTMLInputElement;
  const blurb = h("input", { value: e?.blurb || "", placeholder: "Short description (optional)" }) as HTMLInputElement;
  const date = h("input", { type: "date", value: e?.event_date?.slice(0, 10) || "" }) as HTMLInputElement;
  const venue = h("input", { value: e?.venue || "", placeholder: "Venue (optional)" }) as HTMLInputElement;
  const accent = h("input", { type: "color", value: e?.accent || "#6741d9" }) as HTMLInputElement;
  const image = h("input", { value: e?.image || "", placeholder: "Poster image URL" }) as HTMLInputElement;
  const active = h("input", { type: "checkbox", checked: e ? e.active : true }) as HTMLInputElement;

  // Tiers editor (defaults to a single "General Admission")
  const tiers: Tier[] = e && e.tiers.length ? e.tiers.map((t) => ({ ...t })) : [{ name: "General Admission", price: e?.price || 0, capacity: e?.capacity ?? null }];
  const tierWrap = h("div", { class: "et-tiers-edit" });
  const renderTiers = () => {
    tierWrap.innerHTML = "";
    tiers.forEach((t, i) => {
      const tn = h("input", { value: t.name, placeholder: "Tier name" }) as HTMLInputElement;
      const tp = h("input", { type: "number", min: "0", step: "0.01", value: String(t.price), placeholder: "Price" }) as HTMLInputElement;
      const tc = h("input", { type: "number", min: "1", value: t.capacity != null ? String(t.capacity) : "", placeholder: "Cap" }) as HTMLInputElement;
      tn.addEventListener("input", () => { t.name = tn.value; });
      tp.addEventListener("input", () => { t.price = Number(tp.value) || 0; });
      tc.addEventListener("input", () => { t.capacity = tc.value ? Number(tc.value) : null; });
      tierWrap.append(h("div", { class: "et-tier-row" }, tn, tp, tc, h("button", { class: "ghost sm", onClick: () => { tiers.splice(i, 1); renderTiers(); } }, iconEl("x", 12))));
    });
  };
  renderTiers();
  const addTier = h("button", { class: "ghost sm", onClick: () => { tiers.push({ name: "VIP", price: 0, capacity: null }); renderTiers(); } }, iconEl("plus", 13), "Add tier");

  const fileInput = h("input", { type: "file", accept: "image/*", style: { display: "none" }, onChange: async (ev: any) => { const file = ev.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = async () => { try { const r = await bvApi<{ url: string }>("/api/upload", { method: "POST", body: JSON.stringify({ data: reader.result }) }); image.value = r.url; flash("Poster uploaded", "success"); } catch (err: any) { toast(err?.message || "Upload failed", "error"); } }; reader.readAsDataURL(file); } }) as HTMLInputElement;
  const uploadBtn = h("button", { class: "ghost sm", disabled: !canStore, title: canStore ? "" : "Image hosting not configured — paste a URL", onClick: () => fileInput.click() }, iconEl("download", 14), "Upload poster");

  const body = h("div", { class: "et-form" },
    field("Event name", name), field("Description", blurb),
    h("div", { class: "et-form-grid" }, field("Date", date), field("Venue", venue)),
    h("div", { class: "et-form-grid" }, fieldColor("Accent colour", accent), field("Poster URL", image)),
    h("div", { class: "et-imgbtns" }, uploadBtn, fileInput),
    h("div", { class: "bv-label" }, "Ticket tiers"),
    h("div", { class: "et-tier-head bv-muted" }, h("span", null, "Name"), h("span", null, "Price"), h("span", null, "Cap")),
    tierWrap, addTier,
    e ? h("label", { class: "et-check" }, active, " Active (selling tickets)") : null);
  const save = async () => {
    const cleanTiers = tiers.filter((t) => t.name.trim() && t.price >= 0);
    if (!name.value.trim() || !cleanTiers.length) { toast("Name and at least one tier are required", "warning"); return; }
    const t0 = cleanTiers[0]!;
    const payload: any = { name: name.value, blurb: blurb.value, event_date: date.value || null, venue: venue.value || null, price: t0.price, capacity: t0.capacity, accent: accent.value, image: image.value || null, tiers: cleanTiers };
    try { if (e) { payload.active = active.checked; await bvApi(`/api/events/${e.id}`, { method: "PATCH", body: JSON.stringify(payload) }); } else await bvApi("/api/events", { method: "POST", body: JSON.stringify(payload) }); flash(e ? "Saved" : "Event created", "success"); shell.select("events"); }
    catch (err: any) { toast(err?.message || "error", "error"); }
  };
  openModal({ title: e ? "Edit event" : "New event", body, actions: [{ label: e ? "Save" : "Create", primary: true, onClick: () => { void save(); } }] });
}

/* ------------------------------------------------------------------ Check-in */
let scanStream: MediaStream | null = null;
function stopScan() { if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; } }

function renderCheckin(host: HTMLElement) {
  stopScan();
  const codeInput = h("input", { placeholder: "Scan or type code", style: { textTransform: "uppercase", fontSize: "1.1rem", textAlign: "center", letterSpacing: "0.05em" }, autofocus: true }) as HTMLInputElement;
  const result = h("div", { class: "et-checkin-result" });
  const submit = async (code: string) => {
    result.innerHTML = "";
    if (!String(code).trim()) return;
    try {
      const r = await bvApi<{ found: boolean; ticket?: Ticket; checked_in?: boolean; warning?: string; remaining?: number }>("/api/tickets/checkin", { method: "POST", body: JSON.stringify({ code }) });
      if (!r.found) { result.append(h("div", { class: "et-ck et-ck-bad" }, iconEl("x", 22), h("strong", null, "No such ticket"))); return; }
      const t = r.ticket!;
      if (r.checked_in) result.append(h("div", { class: "et-ck et-ck-ok" }, iconEl("check", 22), h("div", null, h("strong", null, "Welcome in!"), h("div", null, `${t.holder_name || t.holder_email || t.code}${t.tier_name ? ` · ${t.tier_name}` : ""}${r.remaining != null && r.remaining > 0 ? ` · ${r.remaining} admission${r.remaining === 1 ? "" : "s"} left on this ticket` : ""}`))));
      else if (r.warning === "already") result.append(h("div", { class: "et-ck et-ck-warn" }, iconEl("alert", 22), h("strong", null, "Already checked in")));
      else if (r.warning === "bad_signature") result.append(h("div", { class: "et-ck et-ck-bad" }, iconEl("x", 22), h("strong", null, "Invalid / forged code")));
      else if (r.warning === "not_paid") result.append(h("div", { class: "et-ck et-ck-warn" }, iconEl("alert", 22), h("strong", null, "Not paid for yet")));
      else if (r.warning === "refunded") result.append(h("div", { class: "et-ck et-ck-bad" }, iconEl("x", 22), h("strong", null, "Refunded ticket")));
      codeInput.value = ""; codeInput.focus();
    } catch (err: any) { toast(err?.message || "error", "error"); }
  };
  codeInput.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") void submit(codeInput.value); });

  const video = h("video", { autoplay: true, playsinline: true, muted: true, class: "et-scan-video" }) as HTMLVideoElement;
  const scanWrap = h("div", { class: "et-scan", style: { display: "none" } }, video, h("div", { class: "et-scan-frame" }));
  const hasBD = "BarcodeDetector" in window;
  let scanning = false;
  const scanBtn = h("button", { class: "ghost", onClick: () => { void toggleScan(); } }, iconEl("qr", 16), "Scan QR") as HTMLButtonElement;
  const setBtn = () => { scanBtn.replaceChildren(iconEl(scanning ? "x" : "qr", 16), document.createTextNode(scanning ? "Stop scanning" : "Scan QR")); };
  const toggleScan = async () => {
    if (scanning) { stopScan(); scanWrap.style.display = "none"; scanning = false; setBtn(); return; }
    if (!hasBD) { toast("This browser can't scan QR codes — type the code instead.", "warning"); return; }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      video.srcObject = scanStream; scanWrap.style.display = "block"; scanning = true; setBtn();
      const detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
      const tick = async () => {
        if (!scanning || !scanStream) return;
        try { const codes = await detector.detect(video); const raw = codes?.[0]?.rawValue; if (raw) { stopScan(); scanWrap.style.display = "none"; scanning = false; setBtn(); await submit(String(raw).trim()); return; } } catch { /* */ }
        requestAnimationFrame(() => { void tick(); });
      };
      requestAnimationFrame(() => { void tick(); });
    } catch { toast("Couldn't open the camera. Check permissions.", "error"); }
  };

  host.append(card({ title: "Door check-in", body: h("div", { class: "et-checkin" },
    h("p", { class: "bv-muted" }, "Scan each admission QR with the camera, or enter a code by hand. Forged or already-used codes are rejected."),
    h("div", { class: "et-checkin-row" }, codeInput, h("button", { class: "primary", onClick: () => { void submit(codeInput.value); } }, "Check in")),
    h("div", { class: "et-scan-bar" }, scanBtn, !hasBD ? h("span", { class: "bv-muted" }, "Camera scan needs Chrome/Android") : null),
    scanWrap, result) }));
}

/* ------------------------------------------------------------------- Tickets */
async function renderTickets(host: HTMLElement) {
  stopScan();
  if (!events.length) { try { events = (await bvApi<{ events: Event[] }>("/api/events")).events; } catch { /* */ } }
  if (!events.length) { host.append(emptyState({ icon: "list", title: "No events", text: "Create an event first." })); return; }
  if (!ticketEvent || !events.find((e) => e.id === ticketEvent)) ticketEvent = events[0]!.id;
  const picker = h("select", { onChange: (e: any) => { ticketEvent = Number(e.target.value); shell.select("tickets"); } }, ...events.map((e) => h("option", { value: String(e.id), selected: e.id === ticketEvent }, e.name))) as HTMLSelectElement;
  const search = h("input", { class: "et-search", placeholder: "Search…", value: tSearch, onKeyDown: (e: any) => { if (e.key === "Enter") { tSearch = e.target.value; shell.select("tickets"); } } }) as HTMLInputElement;
  const comp = h("button", { class: "ghost sm", onClick: () => openComp(ticketEvent) }, iconEl("plus", 13), "Comp ticket");
  const csv = h("a", { class: "ghost sm", href: "#", onClick: (e: any) => { e.preventDefault(); fetch(`/api/events/${ticketEvent}/attendees.csv`, { headers: { "X-BV-Session": sidOf() } }).then((r) => r.blob()).then((b) => { const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "attendees.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10000); }).catch(() => toast("Couldn't export", "error")); } }, iconEl("download", 13), "CSV");
  const body = h("div");
  host.append(card({ title: "Tickets", action: h("div", { class: "et-toolbar" }, picker, search, comp, csv), body }));
  body.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let rows: Ticket[];
  try { rows = (await bvApi<{ tickets: Ticket[] }>(`/api/events/${ticketEvent}/tickets?refresh=1&q=${encodeURIComponent(tSearch)}`)).tickets; }
  catch (err: any) { body.innerHTML = ""; body.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  body.innerHTML = "";
  body.append(rows.length ? dataTable<Ticket>({
    columns: [
      { head: "Code", cell: (t) => h("div", null, h("strong", { class: "et-code" }, t.code), t.tier_name ? h("div", { class: "bv-muted" }, t.tier_name) : null, t.comp ? pill("comp", "accent") : null) },
      { head: "Holder", cell: (t) => h("div", null, h("span", null, t.holder_name || "—"), t.holder_email ? h("div", { class: "bv-muted" }, t.holder_email) : null) },
      { head: "Admissions", num: true, cell: (t) => `${t.checked_in_count}/${t.qty}` },
      { head: "Paid", num: true, cell: (t) => fmtMoney(t.amount, t.currency) },
      { head: "State", cell: (t) => pill(t.state.replace("_", " "), t.state === "active" ? "ok" : t.state === "checked_in" ? "accent" : t.refunded ? "bad" : "warn") },
    ], rows,
    rowActions: (t) => h("div", { class: "et-row-actions" },
      h("a", { class: "ghost sm", href: `/t/${t.code}`, target: "_blank", rel: "noopener", title: "View ticket QR" }, iconEl("qr", 14)),
      (t.state !== "awaiting" && t.holder_email && !t.refunded) ? h("button", { class: "ghost sm", onClick: () => resend(t) }, iconEl("send", 13)) : null,
      (t.state !== "awaiting" && !t.refunded) ? h("button", { class: "ghost sm", onClick: () => { if (confirm("Mark this ticket refunded? It can't be checked in.")) refund(t); } }, "Refund") : null),
  }) : emptyState({ icon: "inbox", title: "No tickets yet", text: "Share the public link, or issue a comp ticket." }));
}
function openComp(eventId: number) {
  const name = h("input", { placeholder: "Guest name" }) as HTMLInputElement;
  const email = h("input", { type: "email", placeholder: "Email (to send the QR)" }) as HTMLInputElement;
  const qty = h("input", { type: "number", min: "1", max: "20", value: "1" }) as HTMLInputElement;
  const tier = h("input", { value: "Comp", placeholder: "Tier label" }) as HTMLInputElement;
  openModal({ title: "Comp (free) ticket", body: h("div", { class: "et-form" }, field("Guest name", name), field("Email", email), h("div", { class: "et-form-grid" }, field("Quantity", qty), field("Tier", tier))),
    actions: [{ label: "Issue", primary: true, onClick: () => { void (async () => { try { await bvApi(`/api/events/${eventId}/comp`, { method: "POST", body: JSON.stringify({ name: name.value, email: email.value || null, qty: Number(qty.value) || 1, tier_name: tier.value || "Comp" }) }); flash("Comp ticket issued", "success"); shell.select("tickets"); } catch (e: any) { toast(e?.message || "error", "error"); } })(); } }] });
}
async function resend(t: Ticket) { try { const r = await bvApi<{ sent: boolean }>(`/api/tickets/${t.id}/resend`, { method: "POST" }); flash(r.sent ? "Ticket re-sent" : "Email isn't configured", r.sent ? "success" : "warning"); } catch (e: any) { toast(e?.message || "error", "error"); } }
async function refund(t: Ticket) { try { await bvApi(`/api/tickets/${t.id}`, { method: "PATCH", body: JSON.stringify({ refunded: true }) }); flash("Refunded", "success"); shell.select("tickets"); } catch (e: any) { toast(e?.message || "error", "error"); } }

/* ---------------------------------------------------------------- Analytics */
async function renderAnalytics(host: HTMLElement) {
  stopScan();
  if (!events.length) { try { events = (await bvApi<{ events: Event[] }>("/api/events")).events; } catch { /* */ } }
  if (!events.length) { host.append(emptyState({ icon: "chart", title: "No events", text: "Create an event first." })); return; }
  if (!ticketEvent || !events.find((e) => e.id === ticketEvent)) ticketEvent = events[0]!.id;
  const picker = h("select", { onChange: (e: any) => { ticketEvent = Number(e.target.value); shell.select("analytics"); } }, ...events.map((e) => h("option", { value: String(e.id), selected: e.id === ticketEvent }, e.name))) as HTMLSelectElement;
  let a: Analytics;
  try { a = await bvApi(`/api/events/${ticketEvent}/analytics`); }
  catch (err: any) { host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.append(statRow([
    { k: "Revenue", v: fmtMoney(a.revenue, currency), tone: "ok", icon: "coins" },
    { k: "Admissions sold", v: String(a.admissions), tone: "accent", icon: "users" },
    { k: "Checked in", v: `${a.checked_in} (${a.checkin_rate}%)`, icon: "check" },
    { k: "Awaiting", v: String(a.awaiting), icon: "clock" },
  ]));
  host.append(card({ title: "By tier", action: picker, body: a.by_tier.length ? dataTable<any>({
    columns: [
      { head: "Tier", cell: (t) => h("strong", null, t.tier) },
      { head: "Sold", num: true, cell: (t) => String(t.sold) },
      { head: "Revenue", num: true, cell: (t) => fmtMoney(t.revenue, currency) },
    ], rows: a.by_tier,
  }) : emptyState({ icon: "chart", title: "No sales yet", text: "Revenue appears once tickets are bought." }) }));
}

function field(label: string, el: HTMLElement) { return h("label", { class: "et-field" }, h("span", { class: "bv-label" }, label), el); }
function fieldColor(label: string, el: HTMLElement) { return h("label", { class: "et-field et-field-color" }, h("span", { class: "bv-label" }, label), el); }
function fatal(msg?: string) { return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Event Tickets couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard.")); }
