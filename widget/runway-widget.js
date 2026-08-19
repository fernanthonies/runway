// Runway — iOS home/lock screen widget for Scriptable.
//
// Reads GET /api/widget and shows what's left this week and this month.
// Install: see widget/README.md. Set HOST below to your Runway address.
//
// LAN-only by design: off the home network the fetch fails and the widget
// falls back to the last good payload, dimmed, with the time it was taken.

const HOST = "http://192.168.1.172:8100";
const TIMEOUT_SECONDS = 6;
const REFRESH_MINUTES = 15;

// The dark "instrument panel" palette, matching static/style.css.
const COLORS = {
  bgDeep: new Color("#060907"),
  bgTint: new Color("#0d1611"),
  ink: new Color("#e9f3ed"),
  muted: new Color("#7c8f86"),
  ok: new Color("#63f2ac"),
  low: new Color("#ffc25c"),
  neg: new Color("#ff6a5a"),
  unset: new Color("#7c8f86"),
};

const CACHE = FileManager.local().joinPath(
  FileManager.local().libraryDirectory(),
  "runway-widget-cache.json"
);

/* ── data ────────────────────────────────────────────────────────── */

function fail(title, detail) {
  const err = new Error(detail);
  err.title = title;
  return err;
}

async function fetchData() {
  const req = new Request(`${HOST}/api/widget`);
  req.timeoutInterval = TIMEOUT_SECONDS;

  let data;
  try {
    data = await req.loadJSON();
  } catch (err) {
    // Nothing answered: wrong host, off the LAN, server down, or iOS never
    // got Local Network permission.
    throw fail("Runway unreachable", `${HOST}\n${err}`);
  }

  // A 404 body is still valid JSON, so the status has to be checked or a
  // server running an older build reads as a network failure.
  const status = req.response ? req.response.statusCode : 0;
  if (status && status !== 200) {
    throw fail(
      `Server said ${status}`,
      status === 404
        ? "No /api/widget route. Rebuild the server: docker compose up -d --build"
        : `${HOST}/api/widget`
    );
  }
  if (!data || !data.week || !data.month) {
    throw fail("Unexpected payload", "The response is missing week/month.");
  }
  return data;
}

function readCache() {
  const fm = FileManager.local();
  if (!fm.fileExists(CACHE)) return null;
  try {
    return JSON.parse(fm.readString(CACHE));
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    FileManager.local().writeString(CACHE, JSON.stringify(data));
  } catch {
    // A failed cache write only costs us the offline fallback; never fatal.
  }
}

// Returns {data, stale}. `stale` means the network failed and this is the
// last payload we successfully fetched — possibly from days ago.
async function loadData() {
  try {
    const data = await fetchData();
    writeCache(data);
    return { data, stale: false };
  } catch (err) {
    const cached = readCache();
    if (cached) return { data: cached, stale: true };
    return {
      data: null,
      stale: true,
      error: { title: err.title || "Runway unreachable", detail: err.message },
    };
  }
}

/* ── formatting ──────────────────────────────────────────────────── */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function money(n, { compact = false, whole = false } = {}) {
  if (compact && Math.abs(n) >= 1000) {
    // "$1.2k" — keeps a four-figure balance inside a small widget.
    return `${n < 0 ? "−" : ""}$${(Math.abs(n) / 1000).toFixed(1)}k`;
  }
  // The circular lock screen slot is too narrow for cents.
  if (whole) return `${n < 0 ? "−" : ""}$${Math.round(Math.abs(n))}`;
  return usd.format(n).replace("-", "−");
}

function colorFor(state) {
  return COLORS[state] || COLORS.ok;
}

function amountText(window, opts) {
  return window.state === "unset" ? "$—" : money(window.remaining, opts);
}

// "2:45 PM" for today's stamp, "Sat 2:45 PM" once it's older than today.
function stampFor(data) {
  const at = new Date(data.as_of);
  const sameDay = new Date().toDateString() === at.toDateString();
  const df = new DateFormatter();
  df.dateFormat = sameDay ? "h:mm a" : "EEE h:mm a";
  return df.string(at);
}

/* ── drawing ─────────────────────────────────────────────────────── */

// A rounded progress bar. Scriptable has no bar primitive, so it's an image.
function meterImage(fraction, state, width = 130, height = 6) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  ctx.setFillColor(new Color("#e9f3ed", 0.12));
  ctx.fillRect(new Rect(0, 0, width, height));

  const filled = Math.max(0, Math.min(1, fraction)) * width;
  if (filled > 0) {
    ctx.setFillColor(colorFor(state));
    ctx.fillRect(new Rect(0, 0, filled, height));
  }
  return ctx.getImage();
}

function addRow(widget, label, window, { compact, withMeter }) {
  const stack = widget.addStack();
  stack.layoutVertically();
  stack.spacing = 2;

  const caption = stack.addText(label);
  caption.font = Font.mediumSystemFont(10);
  caption.textColor = COLORS.muted;

  const amount = stack.addText(amountText(window, { compact }));
  amount.font = Font.boldRoundedSystemFont(compact ? 26 : 30);
  amount.textColor = colorFor(window.state);
  amount.minimumScaleFactor = 0.6;
  amount.lineLimit = 1;

  if (withMeter && window.state !== "unset") {
    stack.addSpacer(3);
    stack.addImage(meterImage(window.fraction, window.state));
  }
}

function addFooter(widget, data, stale) {
  const footer = widget.addStack();
  footer.centerAlignContent();
  const text = footer.addText(stale ? `offline · ${stampFor(data)}` : stampFor(data));
  text.font = Font.systemFont(9);
  text.textColor = stale ? COLORS.low : COLORS.muted;
}

/* ── widget families ─────────────────────────────────────────────── */

function baseWidget(stale) {
  const widget = new ListWidget();
  const gradient = new LinearGradient();
  // A stale widget loses the tint, so an old number never reads as current.
  gradient.colors = stale ? [COLORS.bgDeep, COLORS.bgDeep] : [COLORS.bgTint, COLORS.bgDeep];
  gradient.locations = [0, 1];
  widget.backgroundGradient = gradient;
  widget.setPadding(14, 14, 12, 14);
  return widget;
}

function buildSmall(data, stale) {
  const widget = baseWidget(stale);
  addRow(widget, "THIS WEEK", data.week, { compact: true, withMeter: true });
  widget.addSpacer(8);
  addRow(widget, "THIS MONTH", data.month, { compact: true, withMeter: false });
  widget.addSpacer();
  addFooter(widget, data, stale);
  return widget;
}

function buildMedium(data, stale) {
  const widget = baseWidget(stale);
  const columns = widget.addStack();
  columns.spacing = 16;

  for (const [label, window] of [
    ["THIS WEEK · RESETS SUNDAY", data.week],
    ["THIS MONTH", data.month],
  ]) {
    const column = columns.addStack();
    column.layoutVertically();
    column.size = new Size(140, 0);

    const caption = column.addText(label);
    caption.font = Font.mediumSystemFont(10);
    caption.textColor = COLORS.muted;
    caption.lineLimit = 1;
    caption.minimumScaleFactor = 0.8;

    column.addSpacer(4);
    const amount = column.addText(amountText(window));
    amount.font = Font.boldRoundedSystemFont(32);
    amount.textColor = colorFor(window.state);
    amount.minimumScaleFactor = 0.6;
    amount.lineLimit = 1;

    if (window.state !== "unset") {
      column.addSpacer(6);
      column.addImage(meterImage(window.fraction, window.state, 140, 6));
      column.addSpacer(4);
      const spent = column.addText(`${money(window.spent)} of ${money(window.allowance)}`);
      spent.font = Font.systemFont(10);
      spent.textColor = COLORS.muted;
      spent.lineLimit = 1;
    }
  }

  widget.addSpacer();
  addFooter(widget, data, stale);
  return widget;
}

// Lock screen widgets are rendered monochrome by iOS, so state has to be
// carried by text rather than colour.
function buildAccessoryRectangular(data, stale) {
  const widget = new ListWidget();
  widget.addAccessoryWidgetBackground = true;

  const title = widget.addText("RUNWAY");
  title.font = Font.mediumSystemFont(11);

  const week = widget.addText(`Week ${amountText(data.week, { compact: true })}`);
  week.font = Font.boldRoundedSystemFont(16);
  week.lineLimit = 1;

  const month = widget.addText(
    `Month ${amountText(data.month, { compact: true })}${stale ? " · offline" : ""}`
  );
  month.font = Font.systemFont(11);
  month.lineLimit = 1;
  return widget;
}

function buildAccessoryInline(data, stale) {
  const widget = new ListWidget();
  widget.addText(
    `Week ${amountText(data.week, { compact: true })}${stale ? " (offline)" : ""}`
  );
  return widget;
}

function buildAccessoryCircular(data) {
  const widget = new ListWidget();
  widget.addAccessoryWidgetBackground = true;
  widget.addSpacer();
  const amount = widget.addText(amountText(data.week, { compact: true, whole: true }));
  amount.font = Font.boldRoundedSystemFont(14);
  amount.minimumScaleFactor = 0.5;
  amount.lineLimit = 1;
  amount.centerAlignText();
  widget.addSpacer();
  return widget;
}

function buildError(error) {
  const widget = baseWidget(true);
  const title = widget.addText(error.title);
  title.font = Font.mediumSystemFont(13);
  title.textColor = COLORS.low;
  title.minimumScaleFactor = 0.8;
  widget.addSpacer(4);
  const detail = widget.addText(error.detail);
  detail.font = Font.systemFont(10);
  detail.textColor = COLORS.muted;
  detail.lineLimit = 5;
  detail.minimumScaleFactor = 0.8;
  return widget;
}

/* ── entry point ─────────────────────────────────────────────────── */

const { data, stale, error } = await loadData();
const family = config.widgetFamily || "medium";

let widget;
if (!data) {
  widget = buildError(error);
} else if (family === "accessoryRectangular") {
  widget = buildAccessoryRectangular(data, stale);
} else if (family === "accessoryInline") {
  widget = buildAccessoryInline(data, stale);
} else if (family === "accessoryCircular") {
  widget = buildAccessoryCircular(data);
} else if (family === "small") {
  widget = buildSmall(data, stale);
} else {
  widget = buildMedium(data, stale);
}

// A hint, not a guarantee — iOS decides when it actually reloads.
widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
widget.url = HOST;

if (config.runsInWidget) {
  Script.setWidget(widget);
} else if (family === "small") {
  await widget.presentSmall();
} else {
  await widget.presentMedium();
}
Script.complete();
