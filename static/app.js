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
  date: $("#dateInput"),
  formError: $("#formError"),
  recentList: $("#recentList"),
  recentEmpty: $("#recentEmpty"),
  settingsBtn: $("#settingsBtn"),
  settingsPanel: $("#settingsPanel"),
  budgetInput: $("#budgetInput"),
  budgetSave: $("#budgetSave"),
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
};

const state = {
  summary: null,
  merchants: [],
  categories: [],
  shown: { monthly: 0, weekly: 0 }, // currently displayed values, for tick animation
  firstRunNudged: false,
  history: { items: [], total: 0, loaded: false },
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
  state.categories = categories.categories;
  renderSummary(summary, animate);
  renderRecent(recent.transactions);
  fillSelect(els.filterMerchant, state.merchants, "All merchants");
  fillSelect(els.filterCategory, state.categories, "All categories");
  if (state.history.loaded) await loadHistory(true);
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
  els.budgetInput.focus();
}

function closeSettings() {
  els.settingsPanel.hidden = true;
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

  const dateInput = Object.assign(document.createElement("input"), { type: "date", value: t.date });
  dateInput.setAttribute("aria-label", "Date");
  const dateField = makeField("date-field", dateInput);

  const grid = document.createElement("div");
  grid.className = "edit-grid";
  grid.append(amountField, merchantField, categoryField);

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

  attachAutocomplete(merchantInput, () => state.merchants);
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
  const history = location.hash === "#history";
  els.dashboardView.hidden = history;
  els.historyView.hidden = !history;
  els.navDashboard.classList.toggle("active", !history);
  els.navHistory.classList.toggle("active", history);
  if (history && !state.history.loaded) loadHistory(true);
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

/* ── autocomplete ────────────────────────────────────────────────── */

function attachAutocomplete(input, getItems) {
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

  input.addEventListener("input", update);
  input.addEventListener("focus", update);
  input.addEventListener("blur", () => close());
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

/* ── init ────────────────────────────────────────────────────────── */

attachAutocomplete(els.merchant, () => state.merchants);
attachAutocomplete(els.category, () => state.categories);
els.form.addEventListener("submit", submitTransaction);
els.date.value = todayISO();

showView();
refreshAll().catch((err) => showError(err.message));
