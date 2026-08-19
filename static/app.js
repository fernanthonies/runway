/* Runway — budget tracker frontend */

const $ = (sel) => document.querySelector(sel);

const els = {
  monthLabel: $("#monthLabel"),
  weekLabel: $("#weekLabel"),
  monthlyAmount: $("#monthlyAmount"),
  weeklyAmount: $("#weeklyAmount"),
  monthlyMeter: $("#monthlyMeter"),
  weeklyMeter: $("#weeklyMeter"),
  firstRunHint: $("#firstRunHint"),
  form: $("#txnForm"),
  amount: $("#amountInput"),
  merchant: $("#merchantInput"),
  category: $("#categoryInput"),
  comment: $("#commentInput"),
  date: $("#dateInput"),
  formError: $("#formError"),
  recentList: $("#recentList"),
  recentEmpty: $("#recentEmpty"),
  settingsBtn: $("#settingsBtn"),
  settingsPanel: $("#settingsPanel"),
  budgetInput: $("#budgetInput"),
  budgetSave: $("#budgetSave"),
  resetBtn: $("#resetBtn"),
  resetConfirm: $("#resetConfirm"),
  resetCancel: $("#resetCancel"),
  resetYes: $("#resetYes"),
  resetNote: $("#resetNote"),
  dashboardView: $("#dashboardView"),
  historyView: $("#historyView"),
  navDashboard: $("#navDashboard"),
  navHistory: $("#navHistory"),
  filterStart: $("#filterStart"),
  filterEnd: $("#filterEnd"),
  filterMerchant: $("#filterMerchant"),
  filterCategory: $("#filterCategory"),
  filterClear: $("#filterClear"),
  historyMeta: $("#historyMeta"),
  historyList: $("#historyList"),
  historyEmpty: $("#historyEmpty"),
  historyError: $("#historyError"),
  loadMore: $("#loadMore"),
  statsView: $("#statsView"),
  navStats: $("#navStats"),
  presetRow: $("#presetRow"),
  statsStart: $("#statsStart"),
  statsEnd: $("#statsEnd"),
  statsMerchant: $("#statsMerchant"),
  statsCategory: $("#statsCategory"),
  statsClear: $("#statsClear"),
  statsToHistory: $("#statsToHistory"),
  statSpent: $("#statSpent"),
  statCount: $("#statCount"),
  statAverage: $("#statAverage"),
  statTopCategory: $("#statTopCategory"),
  statsEmpty: $("#statsEmpty"),
  statsError: $("#statsError"),
  statsCharts: $("#statsCharts"),
  categoryLegend: $("#categoryLegend"),
  monthLegend: $("#monthLegend"),
};

const state = {
  summary: null,
  merchants: [],
  categories: [],
  merchantCategories: {}, // merchant name -> its most-used category, for autofill
  shown: { monthly: 0, weekly: 0 }, // currently displayed values, for tick animation
  firstRunNudged: false,
  history: { items: [], total: 0, loaded: false },
  stats: { loaded: false, preset: "6m", colorMap: null },
};

const HISTORY_PAGE = 50;

/* ── helpers ─────────────────────────────────────────────────────── */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const formatMoney = (n) => usd.format(n).replace("-", "−");

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof data.detail === "string" ? data.detail : "Request failed";
    throw new Error(detail);
  }
  return data;
}

function stateClass(remaining, allowance) {
  if (remaining < 0) return "neg";
  if (allowance > 0 && remaining <= allowance * 0.2) return "low";
  return "ok";
}

function animateAmount(el, from, to, duration = 800) {
  if (from === to) {
    el.textContent = formatMoney(to);
    return;
  }
  const start = performance.now();
  function frame(now) {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = formatMoney(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  el.classList.remove("pulse");
  void el.offsetWidth; // restart animation
  el.classList.add("pulse");
}

/* ── rendering ───────────────────────────────────────────────────── */

const MONTHS = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];

function renderSummary(s, animate = true) {
  state.summary = s;
  const unset = s.monthly_budget <= 0;

  const month = MONTHS[parseInt(s.today.slice(5, 7), 10) - 1];
  els.monthLabel.textContent = `REMAINING · ${month}`;
  els.weekLabel.textContent = "THIS WEEK · RESETS SUNDAY";

  for (const [el, remaining, allowance, key] of [
    [els.monthlyAmount, s.monthly_remaining, s.monthly_budget, "monthly"],
    [els.weeklyAmount, s.weekly_remaining, s.weekly_allowance, "weekly"],
  ]) {
    el.classList.remove("ok", "low", "neg", "unset");
    el.classList.add(unset ? "unset" : stateClass(remaining, allowance));
    if (unset) {
      el.textContent = "$—";
      state.shown[key] = 0;
    } else {
      animateAmount(el, animate ? state.shown[key] : remaining, remaining);
      state.shown[key] = remaining;
    }
  }

  for (const [meter, remaining, allowance] of [
    [els.monthlyMeter, s.monthly_remaining, s.monthly_budget],
    [els.weeklyMeter, s.weekly_remaining, s.weekly_allowance],
  ]) {
    const frac = allowance > 0 ? Math.max(0, Math.min(1, remaining / allowance)) : 0;
    meter.style.width = `${frac * 100}%`;
    meter.classList.remove("ok", "low", "neg");
    if (!unset) meter.classList.add(stateClass(remaining, allowance));
  }

  els.firstRunHint.hidden = !unset;
  if (unset && !state.firstRunNudged) {
    state.firstRunNudged = true;
    openSettings();
  }
}

function renderRecent(transactions) {
  els.recentList.innerHTML = "";
  els.recentEmpty.hidden = transactions.length > 0;
  for (const t of transactions) {
    const li = document.createElement("li");

    const date = document.createElement("span");
    date.className = "txn-date";
    date.textContent = `${t.date.slice(5, 7)}/${t.date.slice(8, 10)}`;

    const merchant = document.createElement("span");
    merchant.className = "txn-merchant";
    merchant.textContent = t.merchant;

    const category = document.createElement("span");
    category.className = "txn-category";
    category.textContent = t.category;

    const amount = document.createElement("span");
    amount.className = "txn-amount";
    amount.textContent = formatMoney(t.amount);

    const del = document.createElement("button");
    del.className = "txn-delete";
    del.title = "Delete transaction";
    del.textContent = "×";
    del.addEventListener("click", () => deleteTransaction(t.id));

    li.append(date, merchant, category, amount, del);
    els.recentList.appendChild(li);
  }
}

/* ── data flows ──────────────────────────────────────────────────── */

async function refreshAll(animate = true) {
  const [summary, recent, merchants, categories] = await Promise.all([
    api("/summary"),
    api("/transactions?limit=5"),
    api("/merchants"),
    api("/categories"),
  ]);
  state.merchants = merchants.merchants;
  state.merchantCategories = merchants.top_categories;
  state.categories = categories.categories;
  renderSummary(summary, animate);
  renderRecent(recent.transactions);
  fillSelect(els.filterMerchant, state.merchants, "All merchants");
  fillSelect(els.filterCategory, state.categories, "All categories");
  fillSelect(els.statsMerchant, state.merchants, "All merchants");
  fillSelect(els.statsCategory, state.categories, "All categories");
  if (state.history.loaded) await loadHistory(true);
  if (state.stats.loaded) await loadStats();
}

function showError(msg) {
  els.formError.textContent = msg;
  els.formError.hidden = false;
}

function clearError() {
  els.formError.hidden = true;
}

async function submitTransaction(e) {
  e.preventDefault();
  clearError();

  const amount = parseFloat(els.amount.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    showError("Enter an amount greater than zero.");
    els.amount.focus();
    return;
  }
  if (!els.merchant.value.trim()) {
    showError("Merchant is required.");
    els.merchant.focus();
    return;
  }
  if (!els.category.value.trim()) {
    showError("Category is required.");
    els.category.focus();
    return;
  }

  try {
    await api("/transactions", {
      method: "POST",
      body: JSON.stringify({
        amount,
        merchant: els.merchant.value,
        category: els.category.value,
        date: els.date.value || null,
        comment: els.comment.value || null,
      }),
    });
  } catch (err) {
    showError(err.message);
    return;
  }

  els.form.reset();
  els.date.value = todayISO();
  els.amount.focus();
  await refreshAll();
}

async function deleteTransaction(id, reportError = showError) {
  try {
    await api(`/transactions/${id}`, { method: "DELETE" });
    await refreshAll();
  } catch (err) {
    reportError(err.message);
  }
}

/* ── settings ────────────────────────────────────────────────────── */

function openSettings() {
  els.settingsPanel.hidden = false;
  els.budgetInput.value = state.summary?.monthly_budget > 0 ? state.summary.monthly_budget.toFixed(2) : "";
  els.resetNote.hidden = true;
  els.budgetInput.focus();
}

function closeSettings() {
  els.settingsPanel.hidden = true;
  armReset(false); // never reopen with the confirmation already primed
}

async function saveBudget() {
  const value = parseFloat(els.budgetInput.value);
  if (!Number.isFinite(value) || value < 0) {
    els.budgetInput.focus();
    return;
  }
  try {
    await api("/settings", { method: "PUT", body: JSON.stringify({ monthly_budget: value }) });
    closeSettings();
    await refreshAll();
  } catch (err) {
    showError(err.message);
  }
}

/* ── delete history (soft: the server backs the DB up first) ─────── */

function armReset(armed) {
  els.resetConfirm.hidden = !armed;
  els.resetBtn.hidden = armed;
  if (armed) els.resetNote.hidden = true;
}

function showResetNote(msg, isError) {
  els.resetNote.textContent = msg;
  els.resetNote.classList.toggle("error", isError);
  els.resetNote.hidden = false;
}

async function deleteHistory() {
  els.resetYes.disabled = true;
  try {
    const { backup } = await api("/reset", {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    });
    armReset(false);
    showResetNote(`Deleted. Backed up to data/backups/${backup}`, false);
    state.stats.colorMap = null; // category colors are rank-based; rebuild them
    await refreshAll(false);
  } catch (err) {
    showResetNote(err.message, true);
  } finally {
    els.resetYes.disabled = false;
  }
}

els.resetBtn.addEventListener("click", () => armReset(true));
els.resetCancel.addEventListener("click", () => armReset(false));
els.resetYes.addEventListener("click", deleteHistory);

els.settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  els.settingsPanel.hidden ? openSettings() : closeSettings();
});
els.settingsPanel.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => closeSettings());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSettings();
});
els.budgetSave.addEventListener("click", saveBudget);
els.budgetInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveBudget();
  }
});

/* ── history view ────────────────────────────────────────────────── */

function showHistoryError(msg) {
  els.historyError.textContent = msg;
  els.historyError.hidden = false;
}

function clearHistoryError() {
  els.historyError.hidden = true;
}

function fillSelect(select, names, placeholder) {
  const current = select.value;
  select.innerHTML = "";
  select.append(new Option(placeholder, ""));
  for (const name of names) select.append(new Option(name, name));
  select.value = names.includes(current) ? current : "";
}

function historyQuery(offset) {
  const params = new URLSearchParams({ limit: HISTORY_PAGE, offset });
  if (els.filterStart.value) params.set("start", els.filterStart.value);
  if (els.filterEnd.value) params.set("end", els.filterEnd.value);
  if (els.filterMerchant.value) params.set("merchant", els.filterMerchant.value);
  if (els.filterCategory.value) params.set("category", els.filterCategory.value);
  return `/transactions?${params}`;
}

async function loadHistory(reset = false) {
  clearHistoryError();
  if (reset) state.history.items = [];
  try {
    const data = await api(historyQuery(state.history.items.length));
    state.history.items.push(...data.transactions);
    state.history.total = data.total;
    state.history.loaded = true;
    renderHistory();
  } catch (err) {
    showHistoryError(err.message);
  }
}

function renderHistory() {
  const { items, total } = state.history;
  els.historyMeta.textContent =
    total === 0 ? "HISTORY" : `HISTORY · ${items.length < total ? `${items.length} OF ` : ""}${total}`;
  els.historyEmpty.hidden = total > 0;
  els.loadMore.hidden = items.length >= total;
  els.historyList.innerHTML = "";
  for (const t of items) els.historyList.appendChild(historyRow(t));
}

function historyRow(t) {
  const li = document.createElement("li");

  const date = document.createElement("span");
  date.className = "txn-date";
  date.textContent = `${t.date.slice(5, 7)}/${t.date.slice(8, 10)}`;
  date.title = t.date;

  const merchant = document.createElement("span");
  merchant.className = "txn-merchant";
  merchant.textContent = t.merchant;

  const category = document.createElement("span");
  category.className = "txn-category";
  category.textContent = t.category;

  const amount = document.createElement("span");
  amount.className = "txn-amount";
  amount.textContent = formatMoney(t.amount);

  const edit = document.createElement("button");
  edit.className = "txn-edit";
  edit.title = "Edit transaction";
  edit.textContent = "✎";
  edit.addEventListener("click", () => editRow(li, t));

  const del = document.createElement("button");
  del.className = "txn-delete";
  del.title = "Delete transaction";
  del.textContent = "×";
  del.addEventListener("click", () => deleteTransaction(t.id, showHistoryError));

  li.append(date, merchant, category, amount, edit, del);
  return li;
}

function editRow(li, t) {
  li.classList.add("editing");
  li.innerHTML = "";

  const makeField = (className, input) => {
    const field = document.createElement("div");
    field.className = `field ${className}`;
    field.appendChild(input);
    return field;
  };

  const amountInput = Object.assign(document.createElement("input"), {
    type: "text", inputMode: "decimal", value: t.amount.toFixed(2),
  });
  amountInput.setAttribute("aria-label", "Amount");
  const amountField = makeField("money-field", amountInput);
  const prefix = Object.assign(document.createElement("span"), { className: "prefix", textContent: "$" });
  amountField.prepend(prefix);

  const merchantInput = Object.assign(document.createElement("input"), {
    type: "text", value: t.merchant, autocomplete: "off",
  });
  merchantInput.setAttribute("aria-label", "Merchant");
  const merchantField = makeField("ac-field", merchantInput);

  const categoryInput = Object.assign(document.createElement("input"), {
    type: "text", value: t.category, autocomplete: "off",
  });
  categoryInput.setAttribute("aria-label", "Category");
  const categoryField = makeField("ac-field", categoryInput);

  const commentInput = Object.assign(document.createElement("input"), {
    type: "text", value: t.comment ?? "", placeholder: "Comment (optional)", maxLength: 280,
  });
  commentInput.setAttribute("aria-label", "Comment");
  const commentField = makeField("comment-field", commentInput);

  const dateInput = Object.assign(document.createElement("input"), { type: "date", value: t.date });
  dateInput.setAttribute("aria-label", "Date");
  const dateField = makeField("date-field", dateInput);

  const grid = document.createElement("div");
  grid.className = "edit-grid";
  grid.append(amountField, merchantField, categoryField, commentField);

  const save = Object.assign(document.createElement("button"), {
    type: "button", className: "btn btn-small", textContent: "Save",
  });
  const cancel = Object.assign(document.createElement("button"), {
    type: "button", className: "btn-ghost btn-small", textContent: "Cancel",
  });

  const actions = document.createElement("div");
  actions.className = "edit-actions";
  actions.append(dateField, save, cancel);

  const error = document.createElement("p");
  error.className = "form-error";
  error.hidden = true;

  li.append(grid, actions, error);

  attachAutocomplete(merchantInput, () => state.merchants, categoryAutofiller(categoryInput));
  attachAutocomplete(categoryInput, () => state.categories);

  const showEditError = (msg) => {
    error.textContent = msg;
    error.hidden = false;
  };

  async function saveEdit() {
    error.hidden = true;
    const amount = parseFloat(amountInput.value);
    if (!Number.isFinite(amount) || amount <= 0) {
      showEditError("Enter an amount greater than zero.");
      amountInput.focus();
      return;
    }
    if (!merchantInput.value.trim()) {
      showEditError("Merchant is required.");
      merchantInput.focus();
      return;
    }
    if (!categoryInput.value.trim()) {
      showEditError("Category is required.");
      categoryInput.focus();
      return;
    }
    try {
      await api(`/transactions/${t.id}`, {
        method: "PUT",
        body: JSON.stringify({
          amount,
          merchant: merchantInput.value,
          category: categoryInput.value,
          date: dateInput.value || null,
          comment: commentInput.value || null,
        }),
      });
    } catch (err) {
      showEditError(err.message);
      return;
    }
    await refreshAll(false); // reloads history (and dashboard) with the edit applied
  }

  save.addEventListener("click", saveEdit);
  cancel.addEventListener("click", () => renderHistory());
  // Capture phase: runs before the autocomplete's own handlers close the list,
  // so an Enter/Escape meant for the dropdown never saves/cancels the row.
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !li.querySelector(".ac-list:not([hidden]) .active")) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === "Escape" && !li.querySelector(".ac-list:not([hidden])")) {
      renderHistory();
    }
  }, true);

  amountInput.focus();
  amountInput.select();
}

/* ── view switching ──────────────────────────────────────────────── */

function showView() {
  const view =
    location.hash === "#history" ? "history" : location.hash === "#stats" ? "stats" : "dashboard";
  els.dashboardView.hidden = view !== "dashboard";
  els.historyView.hidden = view !== "history";
  els.statsView.hidden = view !== "stats";
  els.navDashboard.classList.toggle("active", view === "dashboard");
  els.navHistory.classList.toggle("active", view === "history");
  els.navStats.classList.toggle("active", view === "stats");
  if (view === "history" && !state.history.loaded) loadHistory(true);
  if (view === "stats" && !state.stats.loaded) applyPreset(state.stats.preset);
}

window.addEventListener("hashchange", showView);

for (const el of [els.filterStart, els.filterEnd, els.filterMerchant, els.filterCategory]) {
  el.addEventListener("change", () => loadHistory(true));
}
els.filterClear.addEventListener("click", () => {
  els.filterStart.value = "";
  els.filterEnd.value = "";
  els.filterMerchant.value = "";
  els.filterCategory.value = "";
  loadHistory(true);
});
els.loadMore.addEventListener("click", () => loadHistory());

/* ── stats view ──────────────────────────────────────────────────── */

// Categorical palette, stepped for the dark surface and validated (CVD +
// contrast) against it. Slots are assigned to categories by all-time spend
// rank and never reassigned, so filtering doesn't repaint survivors;
// categories past the 8 slots fold into a gray "Other".
const PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const OTHER_COLOR = "#55695f";
const ACCENT = "#63f2ac"; // single-series marks (matches --mint)
const SURFACE = "#0a130e"; // gap color between touching marks
const OTHER_LABEL = "Other";

const charts = { category: null, merchant: null, month: null };

if (window.Chart) {
  Chart.defaults.font.family = "'Azeret Mono', ui-monospace, monospace";
  Chart.defaults.font.size = 10;
  Chart.defaults.color = "#8ba398"; // --dim
  Chart.defaults.plugins.legend.display = false; // legends are HTML, beside the chart
  Object.assign(Chart.defaults.plugins.tooltip, {
    backgroundColor: "rgba(13, 22, 17, 0.96)",
    borderColor: "rgba(233, 243, 237, 0.12)",
    borderWidth: 1,
    titleColor: "#e9f3ed",
    bodyColor: "#8ba398",
    footerColor: "#e9f3ed",
    padding: 12,
    cornerRadius: 8,
    boxWidth: 8,
    boxHeight: 8,
    boxPadding: 4,
    usePointStyle: true,
  });
}

const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1,
});

const HAIR_GRID = "rgba(233, 243, 237, 0.07)";

function colorFor(name) {
  const cm = state.stats.colorMap;
  const key = name.toLowerCase();
  if (!(key in cm.map)) {
    cm.map[key] = cm.assigned < PALETTE.length ? PALETTE[cm.assigned++] : OTHER_COLOR;
  }
  return cm.map[key];
}

async function ensureColorMap() {
  if (state.stats.colorMap) return;
  state.stats.colorMap = { map: {}, assigned: 0 };
  const all = await api("/stats"); // all-time spend order fixes slot assignment
  for (const row of all.by_category) colorFor(row.name);
}

function presetRange(preset) {
  const now = new Date();
  const first = (offset) => new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  switch (preset) {
    case "this-month": return { start: iso(first(0)), end: "" };
    case "last-month":
      return { start: iso(first(-1)), end: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case "3m": return { start: iso(first(-2)), end: "" };
    case "6m": return { start: iso(first(-5)), end: "" };
    case "12m": return { start: iso(first(-11)), end: "" };
    default: return { start: "", end: "" }; // all
  }
}

function updatePresetRow() {
  for (const btn of els.presetRow.querySelectorAll(".preset")) {
    btn.classList.toggle("active", btn.dataset.preset === state.stats.preset);
  }
}

function applyPreset(preset) {
  state.stats.preset = preset;
  const range = presetRange(preset);
  els.statsStart.value = range.start;
  els.statsEnd.value = range.end;
  updatePresetRow();
  loadStats();
}

function showStatsError(msg) {
  els.statsError.textContent = msg;
  els.statsError.hidden = false;
}

function statsQuery() {
  const params = new URLSearchParams();
  if (els.statsStart.value) params.set("start", els.statsStart.value);
  if (els.statsEnd.value) params.set("end", els.statsEnd.value);
  if (els.statsMerchant.value) params.set("merchant", els.statsMerchant.value);
  if (els.statsCategory.value) params.set("category", els.statsCategory.value);
  return params.toString();
}

async function loadStats() {
  els.statsError.hidden = true;
  try {
    await ensureColorMap();
    const q = statsQuery();
    const data = await api(`/stats${q ? `?${q}` : ""}`);
    state.stats.loaded = true;
    renderStats(data);
  } catch (err) {
    showStatsError(err.message);
  }
}

function renderStats(data) {
  const { totals } = data;
  els.statSpent.textContent = formatMoney(totals.spent);
  els.statCount.textContent = totals.count;
  els.statAverage.textContent = formatMoney(totals.average);
  els.statTopCategory.textContent = data.by_category[0]?.name ?? "—";

  const empty = totals.count === 0;
  els.statsEmpty.hidden = !empty;
  els.statsCharts.hidden = empty;
  if (empty) return;

  renderCategoryChart(data.by_category);
  renderMerchantChart(data.by_merchant);
  renderMonthChart(data.by_month);
}

// Palette-slot order for display, so ring/stack neighbors are exactly the
// adjacent pairs the palette was validated on; "Other" always last.
function foldByColor(rows) {
  const slotted = [];
  let other = null;
  for (const row of rows) {
    const color = row.color ?? colorFor(row.name);
    if (color === OTHER_COLOR) {
      other = other || { name: OTHER_LABEL, spent: 0, count: 0, color };
      other.spent += row.spent;
      other.count += row.count ?? 0;
    } else {
      slotted.push({ ...row, color });
    }
  }
  slotted.sort((a, b) => PALETTE.indexOf(a.color) - PALETTE.indexOf(b.color));
  if (other) slotted.push(other);
  return slotted;
}

function replaceChart(key, canvasId, config) {
  charts[key]?.destroy();
  charts[key] = new Chart($(`#${canvasId}`), config);
}

function drillCategory(name) {
  if (name === OTHER_LABEL) return;
  els.statsCategory.value = name;
  loadStats();
}

function drillMerchant(name) {
  if (name === OTHER_LABEL) return;
  els.statsMerchant.value = name;
  loadStats();
}

// Pointer cursor only over marks that actually drill somewhere.
function drillCursor(e, chart, nameAt) {
  const hits = chart.getElementsAtEventForMode(e, "nearest", { intersect: true }, false);
  const name = hits.length ? nameAt(hits[0]) : null;
  e.native.target.style.cursor = name && name !== OTHER_LABEL ? "pointer" : "default";
}

// Direct labels so tooltips enhance rather than gate: values at horizontal bar
// ends, or totals on stacked column caps (skipped when columns get too narrow).
const directLabelPlugin = {
  id: "directLabels",
  afterDatasetsDraw(chart, args, opts) {
    const { ctx } = chart;
    ctx.save();
    ctx.font = "10px 'Azeret Mono', ui-monospace, monospace";
    ctx.fillStyle = "#8ba398";
    if (opts.mode === "bar-end") {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const [i, bar] of chart.getDatasetMeta(0).data.entries()) {
        ctx.fillText(usdCompact.format(chart.data.datasets[0].data[i]), bar.x + 6, bar.y);
      }
    } else if (opts.mode === "stack-top") {
      const labels = chart.data.labels;
      if (chart.chartArea.width / labels.length >= 44) {
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        labels.forEach((_, i) => {
          const total = chart.data.datasets.reduce((sum, d) => sum + (d.data[i] || 0), 0);
          if (total <= 0) return;
          ctx.fillText(
            usdCompact.format(total),
            chart.scales.x.getPixelForValue(i),
            chart.scales.y.getPixelForValue(total) - 5,
          );
        });
      }
    }
    ctx.restore();
  },
};

// The "whole" of the part-to-whole, in the donut's center.
const donutCenterPlugin = {
  id: "donutCenter",
  afterDraw(chart, args, opts) {
    if (!opts.text) return;
    const { ctx, chartArea } = chart;
    const cx = (chartArea.left + chartArea.right) / 2;
    const cy = (chartArea.top + chartArea.bottom) / 2;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#e9f3ed";
    ctx.font = "300 20px 'Azeret Mono', ui-monospace, monospace";
    ctx.fillText(opts.text, cx, cy);
    ctx.fillStyle = "#55695f";
    ctx.font = "500 8px 'Azeret Mono', ui-monospace, monospace";
    ctx.letterSpacing = "3px";
    ctx.fillText("SPENT", cx + 1, cy + 16);
    ctx.restore();
  },
};

function renderLegend(ul, entries, onPick) {
  ul.innerHTML = "";
  for (const entry of entries) {
    const li = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = entry.color;
    const name = document.createElement("span");
    name.className = "legend-name";
    name.textContent = entry.name;
    li.append(swatch, name);
    if (entry.value != null) {
      const value = document.createElement("span");
      value.className = "legend-value";
      value.textContent = entry.value;
      li.appendChild(value);
    }
    if (entry.name === OTHER_LABEL) li.classList.add("static");
    else li.addEventListener("click", () => onPick(entry.name));
    ul.appendChild(li);
  }
}

const SLIVER_FRACTION = 0.03;

function renderCategoryChart(byCategory) {
  const total = byCategory.reduce((sum, r) => sum + r.spent, 0);
  // Slivers are unreadable and unhittable as slices — fold them into "Other"
  // here only; they keep their entity color in the month chart and legend.
  const rows = byCategory.map((r) =>
    r.spent < total * SLIVER_FRACTION ? { ...r, color: OTHER_COLOR } : r,
  );
  const slices = foldByColor(rows);

  renderLegend(
    els.categoryLegend,
    slices.map((s) => ({ name: s.name, color: s.color, value: formatMoney(s.spent) })),
    drillCategory,
  );

  replaceChart("category", "categoryChart", {
    type: "doughnut",
    plugins: [donutCenterPlugin],
    data: {
      labels: slices.map((s) => s.name),
      datasets: [{
        data: slices.map((s) => s.spent),
        backgroundColor: slices.map((s) => s.color),
        borderColor: SURFACE,
        borderWidth: 2,
        hoverBorderColor: SURFACE,
        hoverBorderWidth: 2,
        hoverOffset: 5,
      }],
    },
    options: {
      maintainAspectRatio: false,
      cutout: "62%",
      layout: { padding: 6 }, // room for the hover lift
      onClick: (e, elements) => {
        if (elements.length) drillCategory(slices[elements[0].index].name);
      },
      onHover: (e, elements, chart) => drillCursor(e, chart, (hit) => slices[hit.index].name),
      plugins: {
        donutCenter: { text: total >= 10000 ? usdCompact.format(total) : formatMoney(total) },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const pct = total > 0 ? Math.round((ctx.parsed / total) * 100) : 0;
              return ` ${formatMoney(ctx.parsed)} · ${pct}%`;
            },
          },
        },
      },
    },
  });
}

const MERCHANT_LIMIT = 10;

function renderMerchantChart(byMerchant) {
  const top = byMerchant.slice(0, MERCHANT_LIMIT);
  const rest = byMerchant.slice(MERCHANT_LIMIT);
  const bars = top.map((m) => ({ ...m, color: ACCENT }));
  if (rest.length) {
    bars.push({
      name: OTHER_LABEL,
      spent: rest.reduce((sum, m) => sum + m.spent, 0),
      count: rest.reduce((sum, m) => sum + m.count, 0),
      color: OTHER_COLOR,
    });
  }

  replaceChart("merchant", "merchantChart", {
    type: "bar",
    plugins: [directLabelPlugin],
    data: {
      labels: bars.map((b) => b.name),
      datasets: [{
        data: bars.map((b) => b.spent),
        backgroundColor: bars.map((b) => b.color),
        maxBarThickness: 18,
        borderRadius: 4,
        borderSkipped: "start", // square at the baseline, rounded at the data end
      }],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      // the whole row is the hit target, not just the painted bar
      interaction: { mode: "index", axis: "y", intersect: false },
      onClick: (e, elements) => {
        if (elements.length) drillMerchant(bars[elements[0].index].name);
      },
      onHover: (e, elements) => {
        const name = elements.length ? bars[elements[0].index].name : null;
        e.native.target.style.cursor = name && name !== OTHER_LABEL ? "pointer" : "default";
      },
      scales: {
        x: {
          grace: "12%", // headroom for the bar-end labels
          grid: { color: HAIR_GRID, drawTicks: false },
          border: { display: false },
          ticks: { callback: (v) => usdCompact.format(v), maxTicksLimit: 6 },
        },
        y: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            font: { family: "'Spline Sans', sans-serif", size: 12 },
            autoSkip: false,
            callback(value) {
              const label = this.getLabelForValue(value);
              return label.length > 16 ? `${label.slice(0, 15)}…` : label;
            },
          },
        },
      },
      plugins: {
        directLabels: { mode: "bar-end" },
        tooltip: {
          callbacks: {
            title: (items) => bars[items[0].dataIndex].name, // untruncated
            label: (ctx) => ` ${formatMoney(ctx.parsed.x)} · ${bars[ctx.dataIndex].count} txn${bars[ctx.dataIndex].count === 1 ? "" : "s"}`,
          },
        },
      },
    },
  });
}

const MONTH_NAMES = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

function monthsInRange(byMonth) {
  const dataMonths = byMonth.map((r) => r.month);
  const start = els.statsStart.value?.slice(0, 7) || (dataMonths.length ? dataMonths.reduce((a, b) => (a < b ? a : b)) : null);
  const end = els.statsEnd.value?.slice(0, 7) || todayISO().slice(0, 7);
  if (!start) return [];
  const months = [];
  let [y, m] = start.split("-").map(Number);
  while (months.length < 120) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    months.push(ym);
    if (ym >= end) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}

function renderMonthChart(byMonth) {
  const months = monthsInRange(byMonth);
  const spansYears = new Set(months.map((m) => m.slice(0, 4))).size > 1;
  const labels = months.map((ym) => {
    const name = MONTH_NAMES[Number(ym.slice(5, 7)) - 1];
    return spansYears ? `${name} '${ym.slice(2, 4)}` : name;
  });

  // Fold beyond-palette categories into "Other", then pivot to per-month series.
  const totals = new Map(); // folded name -> {name, spent, color}
  const cells = new Map(); // "name|month" -> spent
  for (const row of byMonth) {
    const color = colorFor(row.category);
    const name = color === OTHER_COLOR ? OTHER_LABEL : row.category;
    const entry = totals.get(name) || { name, spent: 0, color };
    entry.spent += row.spent;
    totals.set(name, entry);
    const key = `${name}|${row.month}`;
    cells.set(key, (cells.get(key) || 0) + row.spent);
  }
  const series = foldByColor([...totals.values()]);
  const single = series.length === 1;

  const datasets = series.map((s) => ({
    label: s.name,
    data: months.map((ym) => cells.get(`${s.name}|${ym}`) || 0),
    backgroundColor: s.color,
    stack: "spend",
    maxBarThickness: 18,
    // 2px surface gap between stacked segments; the topmost segment's border
    // just blends into the surface, and zero-height segments draw nothing visible
    borderColor: SURFACE,
    borderWidth: single ? 0 : { top: 2 },
    borderSkipped: single ? "start" : false,
    borderRadius: single ? 4 : 0,
  }));

  renderLegend(
    els.monthLegend,
    single ? [] : series.map((s) => ({ name: s.name, color: s.color })),
    drillCategory,
  );

  replaceChart("month", "monthChart", {
    type: "bar",
    plugins: [directLabelPlugin],
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false,
      // hovering anywhere in a month's column reads out every category at once
      interaction: { mode: "index", intersect: false },
      onClick: (e, elements, chart) => {
        if (single) return;
        const hits = chart.getElementsAtEventForMode(e, "nearest", { intersect: true }, false);
        if (hits.length) drillCategory(datasets[hits[0].datasetIndex].label);
      },
      onHover: single
        ? undefined
        : (e, elements, chart) => drillCursor(e, chart, (hit) => datasets[hit.datasetIndex].label),
      scales: {
        x: { stacked: true, grid: { display: false }, border: { display: false } },
        y: {
          stacked: true,
          grace: "8%", // headroom for the cap totals
          grid: { color: HAIR_GRID, drawTicks: false },
          border: { display: false },
          ticks: { callback: (v) => usdCompact.format(v), maxTicksLimit: 6 },
        },
      },
      plugins: {
        directLabels: { mode: "stack-top" },
        tooltip: {
          filter: (item) => item.parsed.y > 0,
          callbacks: {
            label: (ctx) => ` ${formatMoney(ctx.parsed.y)} · ${ctx.dataset.label}`,
            footer: (items) => {
              if (items.length < 2) return "";
              return `Total ${formatMoney(items.reduce((sum, i) => sum + i.parsed.y, 0))}`;
            },
          },
        },
      },
    },
  });
}

for (const btn of els.presetRow.querySelectorAll(".preset")) {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
}
for (const el of [els.statsStart, els.statsEnd]) {
  el.addEventListener("change", () => {
    state.stats.preset = null; // custom range
    updatePresetRow();
    loadStats();
  });
}
for (const el of [els.statsMerchant, els.statsCategory]) {
  el.addEventListener("change", () => loadStats());
}
els.statsClear.addEventListener("click", () => {
  els.statsMerchant.value = "";
  els.statsCategory.value = "";
  applyPreset("all");
});
els.statsToHistory.addEventListener("click", () => {
  els.filterStart.value = els.statsStart.value;
  els.filterEnd.value = els.statsEnd.value;
  els.filterMerchant.value = els.statsMerchant.value;
  els.filterCategory.value = els.statsCategory.value;
  loadHistory(true);
});

/* ── autocomplete ────────────────────────────────────────────────── */

function attachAutocomplete(input, getItems, onPick) {
  const field = input.closest(".field");
  const list = document.createElement("ul");
  list.className = "ac-list";
  list.hidden = true;
  field.appendChild(list);

  let items = [];
  let activeIdx = -1;

  function close() {
    list.hidden = true;
    activeIdx = -1;
  }

  function pick(value) {
    input.value = value;
    close();
    input.focus();
    onPick?.(value);
  }

  function render() {
    list.innerHTML = "";
    if (items.length === 0) {
      close();
      return;
    }
    const q = input.value.trim().toLowerCase();
    items.forEach((value, i) => {
      const li = document.createElement("li");
      if (q) {
        const at = value.toLowerCase().indexOf(q);
        li.append(
          value.slice(0, at),
          Object.assign(document.createElement("mark"), { textContent: value.slice(at, at + q.length) }),
          value.slice(at + q.length),
        );
      } else {
        li.textContent = value;
      }
      li.classList.toggle("active", i === activeIdx);
      // mousedown fires before the input's blur, so the click always lands
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(value);
      });
      list.appendChild(li);
    });
    list.hidden = false;
  }

  function update() {
    const q = input.value.trim().toLowerCase();
    items = getItems().filter((v) => v.toLowerCase().includes(q));
    activeIdx = -1;
    render();
  }

  // Typing an existing name out in full and moving on is still choosing that
  // entry, not creating one, so it gets the same onPick side effects as
  // clicking the suggestion. Fires on blur (tab / click away) and on change
  // (Enter, which submits the form without a blur).
  function commit() {
    const typed = input.value.trim().toLowerCase();
    if (!typed) return;
    const match = getItems().find((v) => v.toLowerCase() === typed);
    if (match) onPick?.(match);
  }

  input.addEventListener("input", update);
  input.addEventListener("focus", update);
  input.addEventListener("change", commit);
  input.addEventListener("blur", () => {
    close();
    commit();
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % items.length;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + items.length) % items.length;
      render();
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      pick(items[activeIdx]);
    } else if (e.key === "Escape") {
      close();
    }
  });
}

/* Returns a merchant-pick handler that fills in that merchant's usual category.
   It only writes when the category field is empty or still holds a value this
   filler put there, so a category the user typed is never clobbered — and once
   they edit it, later merchant picks leave it alone. */
function categoryAutofiller(categoryInput) {
  let filled = null;
  return (merchant) => {
    const category = state.merchantCategories[merchant];
    if (!category) return;
    const current = categoryInput.value.trim();
    if (current && current !== filled) return;
    if (current === category) return;
    categoryInput.value = category;
    filled = category;
    categoryInput.classList.remove("autofilled");
    void categoryInput.offsetWidth; // restart animation
    categoryInput.classList.add("autofilled");
  };
}

/* ── init ────────────────────────────────────────────────────────── */

attachAutocomplete(els.merchant, () => state.merchants, categoryAutofiller(els.category));
attachAutocomplete(els.category, () => state.categories);
els.form.addEventListener("submit", submitTransaction);
els.date.value = todayISO();

showView();
refreshAll().catch((err) => showError(err.message));
