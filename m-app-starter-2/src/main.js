import './styles.css';
import './schedule.css';
import { CATEGORIES, CC_CATEGORY_CODES, CARDS, cardStatementCycle, cardStatementPayments, copy, id, money, currentMonth, validMonth, daysInMonth, monthLabel, shortMonth, toCents, parsePostedDate, displayDate, validateDay, emptyPreferences, createMonth, hasLegacyPaycheckDefaults, preferencesFromMonth, sortedCharges, totals, compactSchedule, etsyDepositDays } from './budget.js';
import { createLocalRepository, createCloudRepository } from './repository.js';
import { supabase } from './supabase.js';

const root = document.getElementById('app');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let selectedMonth = currentMonth();
const cardTabs = ['capone', 'amex'].map(id => CARDS.find(card => card.id === id));
let activeCard = cardTabs[0].id;
let cardTouchStart = null;
let knownVendors = [];
let budget = null, revision = 0, preferences = emptyPreferences(), preferencesRevision = 0;
let repository = null, activeUser = null, busy = false, dirty = false, error = '', notice = '', loading = true, loadToken = 0;
const disabled = () => busy || budget?.closed ? 'disabled' : '';
const negative = value => value < 0 ? 'negative' : '';
const amount = value => (value / 100).toFixed(2);
function optionList(selected) {
  const options = [['', 'Uncategorized'], ...Object.entries(CC_CATEGORY_CODES)];
  if (selected && !CATEGORIES.includes(selected)) options.push(['', selected]);
  return options.map(([code, category]) => {
    const label = code ? code + ' · ' + category : category;
    return `<option value="${esc(category)}" ${selected === category ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
}
const cardOptions = selected => CARDS.map(card => `<option value="${card.id}" ${card.id === selected ? 'selected' : ''}>${card.name}</option>`).join('');

function rememberVendors(charges) {
  const storageKey = 'm-app:vendors:' + (activeUser?.id ?? 'local');
  let stored = [];
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (Array.isArray(value)) stored = value;
  } catch {
    // Suggestions can still be used for this session if storage is unavailable.
  }
  const names = new Map();
  for (const entry of [...stored, ...knownVendors, ...charges.map(charge => charge.vendor)]) {
    const name = typeof entry === 'string' ? entry.trim() : '';
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  knownVendors = [...names.values()].sort((a, b) => a.localeCompare(b));
  try { localStorage.setItem(storageKey, JSON.stringify(knownVendors)); }
  catch { /* Keep suggestions in memory. */ }
}

function amountField(value, label, kind, rowId = '', extra = '') {
  return `<input class="amount" type="text" inputmode="decimal" value="${amount(value)}" aria-label="${esc(label)}" data-kind="${kind}" data-id="${esc(rowId)}" ${extra} ${disabled()}>`;
}
function renderAuth() {
  root.innerHTML = `<main class="auth"><div class="wordmark">m.</div><h1>Your month, reconciled.</h1><p>Sign in to open your paycheck schedule, bills, and card activity.</p>${error ? `<p role="alert" class="error">${esc(error)}</p>` : ''}<form id="sign-in"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Signing in…' : 'Sign in'}</button></form></main>`;
}
function scheduleMarkup() {
  const monthNumber = Number(selectedMonth.slice(5));
  const lastDay = daysInMonth(selectedMonth);
  const schedule = compactSchedule(budget);
  const hasBothPayTypes = ['C pay', 'A pay'].every(name => budget.paychecks.some(pay => pay.name === name));
  const rows = schedule.map((row, index) => {
    const received = row.kind === 'pay' && row.pay.received ? ' · Received' : '';
    const balanceClass = row.kind === 'opening' || row.kind === 'balance' ? 'schedule-balance' : '';
    const rowClass = index === schedule.length - 1 ? 'schedule-ending' : balanceClass;
    const rowType = row.expenseType ?? row.kind;
    const amountClass = row.kind === 'savings' ? '' : negative(row.amountCents);
    let date = `${monthNumber}/${row.day}`;
    let status = received;
    let amountName = '';
    if (row.kind === 'opening') amountName = 'opening';
    if (row.kind === 'etsy') amountName = 'etsy-' + row.day;
    if (row.kind === 'pay') {
      const paycheckIndex = budget.paychecks.indexOf(row.pay);
      const name = esc(row.pay.name);
      amountName = 'amount-' + paycheckIndex;
      date = `<span class="schedule-view-value">${date}</span>
        <span class="schedule-edit-controls schedule-date-input">${monthNumber}/<input name="day-${paycheckIndex}" aria-label="${name} day of month" type="number" min="1" max="${lastDay}" value="${row.day}" required></span>`;
      status = `<span class="schedule-view-value">${received}</span>
        <label class="schedule-edit-controls schedule-received"><input name="received-${paycheckIndex}" type="checkbox" ${row.pay.received ? 'checked' : ''}> Received</label>`;
    }
    let displayedAmount = row.amountCents < 0 ? `(${money(-row.amountCents)})` : money(row.amountCents);
    if (amountName) {
      const label = row.kind === 'etsy' ? `${date} ${row.label}` : row.label;
      displayedAmount = `<span class="schedule-view-value">${displayedAmount}</span>
        <input class="schedule-edit-controls schedule-amount-input" name="${amountName}" aria-label="${esc(label)} amount in dollars" inputmode="decimal" value="${amount(row.amountCents)}" ${row.kind === 'etsy' ? '' : 'required'}>`;
    }
    return `<tr class="${rowClass} schedule-type-${rowType}">
      <td class="schedule-date">${date}</td>
      <th scope="row">${esc(row.label)}${status}</th>
      <td class="numeric ${amountClass}">${displayedAmount}</td>
    </tr>`;
  }).join('');

  return `<section class="panel schedule-panel">
    <form id="edit-schedule">
    <div class="panel-heading">
      <h2>Monthly schedule</h2>
      ${budget.closed ? '<span class="pill">Closed</span>' : `<button class="schedule-view-value" type="button" data-action="edit-schedule" ${disabled()}>Edit schedule</button>
      <div class="schedule-edit-controls schedule-editor-actions">
        ${hasBothPayTypes ? '' : '<button type="button" data-action="load-paycheck-template">Use C/A template</button>'}
        <button type="button" data-action="cancel-schedule">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>`}
    </div>
    <div role="alert" class="schedule-edit-controls schedule-editor-error"></div>
    <table class="schedule schedule-ledger" aria-label="Monthly schedule">
      <thead>
        <tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col" class="numeric">Amount</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    </form>
    ${budget.closed ? '' : `<details class="add-details">
      <summary>+ Savings</summary>
      <form id="add-savings" class="inline-form">
        <label>Type<select name="direction" ${disabled()}><option value="to-savings">Transfer to savings</option><option value="from-savings">Withdraw from savings</option></select></label>
        <label>Date<input name="date" type="date" min="${selectedMonth}-01" max="${selectedMonth}-${lastDay}" required ${disabled()}></label>
        <label>Amount ($)<input name="amount" inputmode="decimal" placeholder="0.00" required ${disabled()}></label>
        <button ${disabled()}>Add transfer</button>
        <div role="alert" class="schedule-editor-error"></div>
      </form>
    </details>`}
    <details class="add-details">
      <summary>Add a paycheck</summary>
      <form id="add-pay" class="inline-form">
        <label>Name<input name="name" required maxlength="80" placeholder="Paycheck name" ${disabled()}></label>
        <label>Day<input name="day" type="number" min="1" max="${lastDay}" value="6" required ${disabled()}></label>
        <label>Amount ($)<input name="amount" inputmode="decimal" value="0.00" required ${disabled()}></label>
        <button ${disabled()}>Add paycheck</button>
      </form>
    </details>
  </section>`;
}
function cardChargeTable(charges, scope) {
  if (!charges.length) return '<p class="hint">No card activity entered for this month.</p>';
  const rows = sortedCharges(charges).map(charge => {
    const key = esc(charge.id);
    const vendor = esc(charge.vendor);
    const code = Object.entries(CC_CATEGORY_CODES).find(([, category]) => category === charge.category)?.[0] ?? '—';
    const date = displayDate(charge.postedDate);
    const [year, month, day] = (charge.postedDate ?? '').split('-');
    const edit = budget.closed ? [] : [
      `<select name="category-${key}" data-category-code aria-label="Category code for ${vendor}">${optionList(charge.category)}</select>
        <label class="checkbox-label"><input type="checkbox" name="important-${key}" ${charge.important === true ? 'checked' : ''}>Important</label>`,
      `<input name="vendor-${key}" value="${vendor}" list="card-vendor-history" maxlength="160" aria-label="Vendor for ${vendor}"><select name="card-${key}" aria-label="Card for ${vendor}"><option value="">Unassigned</option>${cardOptions(charge.card)}</select><button class="text-button" type="button" data-action="stage-charge-removal" aria-label="Remove ${vendor}">Remove</button>`,
      `<input name="posted-${key}" value="${year ? `${month}/${day}/${year}` : ''}" placeholder="MM/DD" maxlength="10" aria-label="Date for ${vendor}">`,
      `<input name="amount-${key}" value="${amount(charge.amountCents)}" inputmode="decimal" aria-label="Amount for ${vendor}">`,
    ];
    const cell = (value, index) => `<span class="charge-list-view">${value}</span>${edit[index] ? `<div class="charge-list-edit">${edit[index]}</div>` : ''}`;
    return `<tr data-charge-id="${key}" data-charge-code="${code}"${charge.important === true ? ' class="charge-important"' : ''}>
      <td><span class="charge-list-view" title="${esc(charge.category)}">${code}</span>${edit[0] ? `<div class="charge-list-edit">${edit[0]}</div>` : ''}</td>
      <td>${cell(vendor, 1)}</td>
      <td class="numeric ${negative(charge.amountCents)}">${cell(esc(money(charge.amountCents)), 3)}</td>
      <td>${cell(esc(date || 'Pending'), 2)}</td>
    </tr>`;
  }).join('');
  return `<form class="charge-list" data-charge-scope="${scope}">
    ${budget.closed ? '' : `<div class="charge-list-actions">
      <button class="charge-list-view" type="button" data-action="edit-charges" ${disabled()}>Edit charges</button>
      <div class="charge-list-edit">
        <button class="primary" type="submit" ${disabled()}>Save changes</button>
        <button type="button" data-action="cancel-charge-edits" ${disabled()}>Cancel</button>
      </div>
    </div>`}
    <div class="charge-list-scroll"><table class="charge-list-table">
      <thead><tr><th scope="col">Code</th><th scope="col">Vendor</th><th scope="col" class="numeric">Amount</th><th scope="col">Date</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div role="alert" class="schedule-editor-error"></div>
  </form>`;
}
function cardMarkup() {
  const payments = cardStatementPayments(budget);
  const unassigned = budget.charges.filter(charge => !charge.card);
  const draftEditor = `<div class="charge-draft-editor">
    <label class="charge-draft-vendor">Vendor<input name="vendor" list="card-vendor-history" autocomplete="off" maxlength="160" ${disabled()}></label>
    <label>Amount ($)<input name="amount" inputmode="decimal" placeholder="0.00" ${disabled()}></label>
    <label>Code<select name="category" ${disabled()}>${optionList('Uncategorized')}</select></label>
    <label class="checkbox-label"><input type="checkbox" name="important" ${disabled()}>Important</label>
    <div class="charge-draft-actions">
      <button type="button" data-action="remove-charge-draft" hidden>Remove charge</button>
      <button type="button" data-action="queue-charge" ${disabled()}>Add to batch</button>
    </div>
  </div>`;
  const draftGroup = (editor = '') => `<fieldset class="charge-batch-group">
    <legend>Charges by date</legend>
    <label class="charge-batch-date">Date for this group
      <input name="posted" placeholder="MM/DD or Pending" maxlength="10" autocomplete="off" ${disabled()}>
    </label>
    <div class="charge-draft-list"></div>
    ${editor}
  </fieldset>`;
  const tabs = cardTabs.map(card => {
    const selected = card.id === activeCard;
    return `<button type="button" role="tab" id="card-tab-${card.id}"
      aria-selected="${selected}" aria-controls="card-panel-${card.id}" tabindex="${selected ? 0 : -1}"
      data-action="select-card" data-card="${card.id}">${card.name}</button>`;
  }).join('');
  const panels = cardTabs.map(card => {
    const cycle = cardStatementCycle(selectedMonth, card.dueDay);
    const charges = budget.charges.filter(charge => charge.card === card.id);
    const posted = charges.reduce((sum, charge) => sum + (charge.postedDate ? charge.amountCents : 0), 0);
    const pending = charges.reduce((sum, charge) => sum + (charge.postedDate ? 0 : charge.amountCents), 0);
    const payment = payments.find(item => item.id === card.id);
    return `<div class="card-tab-panel" id="card-panel-${card.id}" role="tabpanel"
      aria-labelledby="card-tab-${card.id}" data-card-panel="${card.id}" ${card.id === activeCard ? '' : 'hidden'}>
      <p class="hint">${card.name} statement cycle · ${displayDate(cycle.from)} to ${displayDate(cycle.until)}</p>
      <div class="card-totals">
        <div>Posted<strong>${money(posted)}</strong></div>
        <div>Pending<strong>${money(pending)}</strong></div>
        <div>${card.name} due <time datetime="${selectedMonth}-${String(card.dueDay).padStart(2, '0')}">${shortMonth(selectedMonth)} ${card.dueDay}</time><strong>${money(payment.amountCents)}</strong></div>
      </div>
      ${cardChargeTable(charges, card.id)}
      ${budget.closed ? '' : `<button type="button" class="primary charge-add-button" data-action="open-charge-dialog" data-card="${card.id}" aria-haspopup="dialog" ${disabled()}>+ Add charges</button>
      <dialog id="charge-dialog-${card.id}" class="charge-dialog" aria-labelledby="charge-dialog-title-${card.id}">
        <h3 id="charge-dialog-title-${card.id}">Add ${card.name} charges</h3>
        <form id="add-charges-${card.id}" class="charge-batch-form">
          <p class="hint">Each group shares one date. Type Pending or leave the group date blank for pending charges.</p>
          <div class="charge-batch-groups">${draftGroup(draftEditor)}</div>
          <div class="charge-batch-actions">
            <button type="button" data-action="add-charge-group" ${disabled()}>+ Add another date</button>
            <button type="button" data-action="close-charge-dialog">Close</button>
            <button type="submit" class="primary" ${disabled()}>Save all charges</button>
          </div>
          <div role="alert" class="schedule-editor-error"></div>
        </form>
      </dialog>`}
    </div>`;
  }).join('');
  return `<section class="panel card-panel">
    <div class="panel-heading"><h2>Credit card activity</h2><span class="pill">${esc(shortMonth(selectedMonth))}</span></div>
    <div class="card-tabs" role="tablist" aria-label="Credit cards">${tabs}</div>
    ${panels}
    <template id="charge-draft-group">${draftGroup()}</template>
    <datalist id="card-vendor-history">${knownVendors.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>
    <p class="hint">Entries belong to ${esc(monthLabel(selectedMonth))}, even if posted in another month. MM/DD uses ${selectedMonth.slice(0, 4)}. Card totals include pending entries. Use a negative amount for a refund.</p>
    ${unassigned.length ? `<details class="statement"><summary>Unassigned charges (${unassigned.length})</summary>${cardChargeTable(unassigned, '')}</details>` : ''}
    <details class="statement"><summary>Unassigned statement payment · ${money(budget.statement.amountCents)}</summary><div class="statement-fields"><label>Balance ($)${amountField(budget.statement.amountCents, 'Previous statement balance', 'statement-amount')}</label><label>Pay on ${esc(shortMonth(selectedMonth))}<input type="number" min="1" max="${daysInMonth(selectedMonth)}" value="${budget.statement.paymentDay}" data-kind="statement-day" ${disabled()}></label><label>Due ${esc(shortMonth(selectedMonth))}<input type="number" min="1" max="${daysInMonth(selectedMonth)}" value="${budget.statement.dueDay}" data-kind="statement-due" ${disabled()}></label></div><button data-action="statement-paid" type="button" ${disabled()} ${!budget.statement.amountCents ? 'disabled' : ''}>${budget.statement.paid ? 'Undo paid' : 'Mark payment cleared'}</button><p class="hint">Use this for a separate payment. If a payment is already included in an Amex or CapOne total, remove its amount here to avoid counting it twice.</p></details>
  </section>`;
}
function billsMarkup() {
  const rows = budget.bills.slice().sort((a, b) => a.day - b.day).map(bill => `<tr><td class="bill-day"><label class="day-label"><span>${esc(shortMonth(selectedMonth))}</span><input type="number" min="1" max="${daysInMonth(selectedMonth)}" value="${bill.day}" data-kind="bill-day" data-id="${bill.id}" aria-label="${esc(bill.name)} debit day" ${disabled()}></label></td><td class="bill-name">${esc(bill.name)}${bill.endOfMonth ? '<span class="hint">End of month</span>' : ''}<button class="text-button" type="button" data-action="remove-bill" data-id="${esc(bill.id)}" aria-label="Remove ${esc(bill.name)} bill" ${disabled()}>Remove</button></td><td class="bill-amount">${amountField(bill.amountCents, `${bill.name} amount`, 'bill-amount', bill.id)}</td><td class="bill-paid"><label class="paid-label"><span class="mobile-label">Paid</span><input type="checkbox" data-kind="bill-paid" data-id="${bill.id}" aria-label="${esc(bill.name)} paid" ${bill.paid ? 'checked' : ''} ${disabled()}></label></td></tr>`).join('');
  return `<section class="panel bills-panel"><div class="panel-heading"><div><h2>Checking bills</h2><p>Amounts and dates apply to this month</p></div><span class="pill">${budget.bills.filter(b => b.paid).length} / ${budget.bills.length} paid</span></div><table class="bills-table"><thead><tr><th>Debit date</th><th>Bill</th><th class="numeric">Amount ($)</th><th class="numeric">Paid</th></tr></thead><tbody>${rows || '<tr class="empty-row"><td colspan="4">Add your recurring bills below.</td></tr>'}</tbody></table><p class="hint numeric">${money(totals(budget).remainingBills)} still to clear</p><details class="add-details"><summary>Add a bill</summary><form id="add-bill" class="inline-form"><label>Bill name<input name="name" maxlength="100" placeholder="Mortgage, water…" required ${disabled()}></label><label>Day<input name="day" type="number" min="1" max="${daysInMonth(selectedMonth)}" value="1" required ${disabled()}></label><label>Amount ($)<input name="amount" inputmode="decimal" placeholder="0.00" required ${disabled()}></label><label class="checkbox-label"><input name="eom" type="checkbox" ${disabled()}>End of month</label><button ${disabled()}>Add bill</button></form></details></section>`;
}
function render() {
  if (supabase && !activeUser) return renderAuth();
  if (!budget) { root.innerHTML = `<main class="auth"><div class="wordmark">m.</div><p>${loading ? 'Opening your month…' : esc(error || 'Could not open your budget.')}</p>${!loading ? '<button data-action="reload">Try again</button>' : ''}</main>`; return; }
  const t = totals(budget);
  root.innerHTML = `<div class="app-shell"><header><div class="topline"><div class="brand">m.<span>app</span></div><div class="account">${supabase ? `<span>${esc(activeUser?.email)}</span><button data-action="sign-out" ${busy || dirty ? 'disabled' : ''}>Sign out</button>` : '<span>Stored on this device</span>'}</div></div><div class="month-heading"><div><h1>${esc(monthLabel(selectedMonth))}</h1><p>Know what each paycheck covers.</p></div><label class="month-picker">Budget month<input type="month" value="${selectedMonth}" data-kind="month" aria-label="Budget month" ${busy || dirty ? 'disabled' : ''}></label></div><div class="save-line" role="status">${busy ? 'Saving…' : dirty ? 'Changes need to be saved' : supabase ? 'Saved to your account' : 'Saved on this device'}${notice ? ` · ${esc(notice)}` : ''}</div></header>${error ? `<div class="error-banner" role="alert"><p>${esc(error)}</p><div>${dirty ? '<button data-action="retry">Retry save</button>' : ''}<button data-action="reload">Reload saved version</button></div></div>` : ''}<main class="workspace">${scheduleMarkup()}<div class="ledgers">${cardMarkup()}${billsMarkup()}</div></main><footer><div>${t.lowest < 0 ? '<span class="negative">A scheduled balance falls below zero.</span>' : 'Every scheduled balance stays at or above zero.'}</div><details><summary>Month options</summary><div class="footer-actions"><button data-action="defaults" ${busy || dirty || budget.closed ? 'disabled' : ''}>Use bills & paychecks as future defaults</button><button data-action="export" ${busy ? 'disabled' : ''}>Export this month</button><button data-action="close" ${busy || dirty ? 'disabled' : ''}>${budget.closed ? 'Reopen month' : 'Close month'}</button></div><p class="hint">All edits belong to ${esc(monthLabel(selectedMonth))}. Future defaults only populate months you have not opened yet.</p></details></footer></div>`;
}
async function loadMonth() {
  const token = ++loadToken;
  activeCard = cardTabs[0].id;
  loading = true; error = ''; budget = null; dirty = false; render();
  try {
    const record = await repository.loadMonth(selectedMonth);
    if (token !== loadToken) return;
    budget = record ? copy(record.document) : createMonth(selectedMonth, preferences);
    rememberVendors(budget.charges);
    if (record && !budget.closed && hasLegacyPaycheckDefaults(budget.paychecks)) {
      budget.paychecks = createMonth(selectedMonth).paychecks;
    }
    revision = record?.revision ?? 0;
  } catch (cause) { if (token === loadToken) error = cause.message; }
  finally { if (token === loadToken) { loading = false; render(); } }
}
async function start(session) {
  activeUser = session?.user ?? null;
  knownVendors = [];
  budget = null; busy = false; dirty = false; error = ''; notice = ''; loading = true; ++loadToken;
  if (supabase && !activeUser) { render(); return; }
  repository = supabase ? createCloudRepository(supabase) : createLocalRepository();
  render();
  try {
    const record = await repository.loadPreferences();
    preferences = record?.document ?? emptyPreferences(); preferencesRevision = record?.revision ?? 0;
    await loadMonth();
  } catch (cause) { error = cause.message; loading = false; render(); }
}
async function persist() {
  busy = true; error = ''; notice = ''; render();
  const savingRepository = repository;
  const document = copy(budget);
  try {
    const record = await savingRepository.saveMonth(document, revision);
    if (repository === savingRepository) rememberVendors(document.charges);
    revision = record.revision; dirty = false; notice = 'Just saved';
  } catch (cause) { error = cause.message; dirty = true; }
  finally { busy = false; render(); }
}
async function commit(update, allowClosed = false) {
  if (busy || !budget || (budget.closed && !allowClosed)) return;
  try { const next = copy(budget); update(next); budget = next; dirty = true; await persist(); }
  catch (cause) { error = cause.message; render(); }
}
function rowById(rows, rowId) {
  const row = rows.find(item => item.id === rowId);
  if (!row) throw new Error('This entry is no longer available. Reload the month.');
  return row;
}
function parseCardDate(value) {
  return parsePostedDate(value, selectedMonth.slice(0, 4));
}
const queuedCharges = new WeakMap();
function setChargeEditor(form, row = null) {
  const editor = form.querySelector('.charge-draft-editor');
  form.querySelector('.charge-draft-item[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
  const charge = queuedCharges.get(row);
  if (row) {
    row.setAttribute('aria-pressed', 'true');
    row.closest('.charge-batch-group').append(editor);
  }
  form.elements.vendor.value = charge?.vendor ?? '';
  form.elements.amount.value = charge ? amount(charge.amountCents) : '';
  form.elements.category.value = charge?.category ?? 'Uncategorized';
  form.elements.important.checked = charge?.important ?? false;
  editor.querySelector('[data-action="queue-charge"]').textContent = row ? 'Update charge' : 'Add to batch';
  editor.querySelector('[data-action="remove-charge-draft"]').hidden = !row;
}
function queueCharge(form, required = false) {
  const message = form.querySelector('.schedule-editor-error');
  message.textContent = '';
  const vendor = form.elements.vendor.value.trim();
  const amountInput = form.elements.amount.value.trim();
  const category = form.elements.category.value;
  const important = form.elements.important.checked;
  let row = form.querySelector('.charge-draft-item[aria-pressed="true"]');
  if (!required && !row && !vendor && !amountInput && category === 'Uncategorized' && !important) return true;
  try {
    if (!vendor) throw new Error('Enter a vendor.');
    const amountCents = toCents(amountInput, true);
    if (!amountCents) throw new Error('Enter a nonzero amount.');
    if (!row) {
      row = document.createElement('button');
      row.type = 'button';
      row.className = 'charge-draft-item';
      row.dataset.action = 'edit-charge-draft';
      row.setAttribute('aria-pressed', 'false');
      form.querySelector('.charge-draft-editor').parentElement.querySelector('.charge-draft-list').append(row);
    }
    const code = Object.entries(CC_CATEGORY_CODES).find(([, name]) => name === category)?.[0];
    row.textContent = [code, vendor, money(amountCents)].filter(Boolean).join(' · ');
    row.classList.toggle('charge-important', important);
    queuedCharges.set(row, { vendor, amountCents, category, important });
    setChargeEditor(form);
    return true;
  } catch (cause) {
    message.textContent = cause.message;
    return false;
  }
}
function selectCard(cardId, focus = false) {
  if (!cardTabs.some(card => card.id === cardId)) return;
  activeCard = cardId;
  for (const tab of root.querySelectorAll('[role="tab"][data-card]')) {
    const selected = tab.dataset.card === cardId;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  for (const panel of root.querySelectorAll('[data-card-panel]')) {
    panel.hidden = panel.dataset.cardPanel !== cardId;
  }
}
root.addEventListener('touchstart', event => {
  cardTouchStart = null;
  if (event.touches.length !== 1 || !event.target.closest('[data-card-panel], .card-tabs') ||
      event.target.closest('input, select, textarea, label, .charge-dialog')) return;
  const { clientX, clientY } = event.touches[0];
  cardTouchStart = { clientX, clientY };
}, { passive: true });
root.addEventListener('touchend', event => {
  const start = cardTouchStart;
  cardTouchStart = null;
  if (!start || event.touches.length || !event.changedTouches.length) return;
  const { clientX, clientY } = event.changedTouches[0];
  const horizontal = clientX - start.clientX;
  if (Math.abs(horizontal) < 55 || Math.abs(horizontal) <= Math.abs(clientY - start.clientY) * 1.5) return;
  selectCard(horizontal < 0 ? cardTabs[1].id : cardTabs[0].id);
}, { passive: true });
root.addEventListener('touchcancel', () => { cardTouchStart = null; });
root.addEventListener('input', event => { event.target.setCustomValidity?.(''); });
root.addEventListener('keydown', event => {
  const input = event.target;
  if (event.key === 'Enter' && input.matches('.charge-batch-form input')) {
    event.preventDefault();
    if (input.name === 'amount' && queueCharge(input.form, true)) input.form.elements.vendor.focus();
    return;
  }
  if (input.matches('[role="tab"][data-card]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const index = cardTabs.findIndex(card => card.id === input.dataset.card);
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    const adjacent = (index + step + cardTabs.length) % cardTabs.length;
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? cardTabs.length - 1 : adjacent;
    selectCard(cardTabs[nextIndex].id, true);
    return;
  }
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey &&
      input.matches('select[data-category-code], select[name="category"]')) {
    const category = CC_CATEGORY_CODES[event.key.toUpperCase()];
    if (category) {
      event.preventDefault();
      if (input.value !== category) {
        input.value = category;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
  }
  if (event.key === 'Enter' && input.matches('input[data-kind]:not([type="checkbox"])')) { event.preventDefault(); input.dispatchEvent(new Event('change', { bubbles: true })); }
});
root.addEventListener('change', async event => {
  const input = event.target, kind = input.dataset.kind, rowId = input.dataset.id;
  if (!kind) return;
  try {
    if (kind === 'month') { if (busy || dirty || !validMonth(input.value)) return; selectedMonth = input.value; notice = ''; await loadMonth(); return; }
    if (busy || budget?.closed) return;
    const isAmount = ['bill-amount', 'statement-amount'].includes(kind);
    const cents = isAmount ? toCents(input.value) : null;
    const day = ['bill-day', 'statement-day', 'statement-due'].includes(kind) ? validateDay(input.value, selectedMonth) : null;
    await commit(next => {
      if (kind === 'bill-amount') rowById(next.bills, rowId).amountCents = cents;
      if (kind === 'bill-day') { const bill = rowById(next.bills, rowId); bill.day = day; bill.endOfMonth = day === daysInMonth(selectedMonth) && bill.endOfMonth; }
      if (kind === 'bill-paid') rowById(next.bills, rowId).paid = input.checked;
      if (kind === 'statement-amount') next.statement.amountCents = cents;
      if (kind === 'statement-day') next.statement.paymentDay = day;
      if (kind === 'statement-due') next.statement.dueDay = day;
    });
  } catch (cause) { input.setCustomValidity?.(cause.message); input.reportValidity?.(); }
});
root.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target, fields = new FormData(form);
  if (form.id === 'sign-in') {
    busy = true; error = ''; renderAuth();
    try { const result = await supabase.auth.signInWithPassword({ email: fields.get('email'), password: fields.get('password') }); if (result.error) throw result.error; await start(result.data.session); }
    catch (cause) { error = cause.message; busy = false; renderAuth(); }
    return;
  }
  if (busy || !budget || budget.closed) return;
  if (form.dataset?.chargeScope !== undefined) {
    if (!form.classList.contains('is-editing')) return;
    const message = form.querySelector('.schedule-editor-error');
    message.textContent = '';
    const updates = new Map();
    const removed = new Set();
    for (const row of form.querySelectorAll('tr[data-charge-id]')) {
      const key = row.dataset.chargeId;
      if (row.hidden) {
        removed.add(key);
        continue;
      }
      const previous = rowById(budget.charges, key);
      try {
        const vendor = fields.get('vendor-' + key).trim();
        if (!vendor) throw new Error('Enter a vendor.');
        const postedDate = parseCardDate(fields.get('posted-' + key));
        const amountCents = toCents(fields.get('amount-' + key), true);
        const category = fields.get('category-' + key);
        const card = fields.get('card-' + key);
        const important = fields.get('important-' + key) === 'on';
        const charge = { ...previous, vendor, postedDate, amountCents, category, important };
        if (card) charge.card = card;
        else delete charge.card;
        updates.set(key, charge);
      } catch (cause) {
        message.textContent = `${previous.vendor}: ${cause.message}`;
        return;
      }
    }
    await commit(next => {
      next.charges = next.charges.filter(charge => !removed.has(charge.id))
        .map(charge => updates.get(charge.id) ?? charge);
    });
    return;
  }
  if (form.id === 'add-charges-' + activeCard) {
    const message = form.querySelector('.schedule-editor-error');
    if (!queueCharge(form)) return;
    const charges = [];
    for (const [groupIndex, group] of form.querySelectorAll('.charge-batch-group').entries()) {
      const rows = group.querySelectorAll('.charge-draft-item');
      if (!rows.length) continue;
      const dateInput = group.querySelector('[name="posted"]').value.trim();
      try {
        const postedDate = parseCardDate(dateInput.toLowerCase() === 'pending' ? '' : dateInput);
        for (const row of rows) charges.push({ ...queuedCharges.get(row), id: id(), postedDate, card: activeCard });
      } catch (cause) {
        message.textContent = `Group ${groupIndex + 1}: ${cause.message}`;
        return;
      }
    }
    if (!charges.length) {
      message.textContent = 'Enter at least one charge.';
      return;
    }
    await commit(next => { next.charges.push(...charges); });
    return;
  }
  if (form.id === 'add-savings') {
    const message = form.querySelector('.schedule-editor-error');
    try {
      message.textContent = '';
      const date = fields.get('date');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== selectedMonth) {
        throw new Error('Choose a date in the selected month.');
      }
      const day = validateDay(date.slice(8), selectedMonth);
      const amountCents = toCents(fields.get('amount'));
      if (!amountCents) throw new Error('Enter an amount greater than zero.');
      const direction = fields.get('direction');
      if (direction !== 'to-savings' && direction !== 'from-savings') throw new Error('Choose a transfer type.');
      const transfer = { id: id(), day, amountCents: direction === 'to-savings' ? -amountCents : amountCents };
      await commit(next => { (next.savingsTransfers ??= []).push(transfer); });
    } catch (cause) {
      message.textContent = cause.message;
    }
    return;
  }
  if (form.id === 'edit-schedule') {
    if (!form.classList.contains('is-editing')) return;
    try {
      const openingCents = toCents(fields.get('opening'), true);
      const etsyDeposits = {};
      for (const day of etsyDepositDays(budget)) {
        const value = fields.get('etsy-' + day).trim();
        const cents = value ? toCents(value) : 0;
        if (cents) etsyDeposits[day] = cents;
      }
      const paychecks = budget.paychecks.map((pay, index) => ({
        ...pay,
        day: validateDay(fields.get('day-' + index), selectedMonth),
        amountCents: toCents(fields.get('amount-' + index)),
        received: fields.has('received-' + index),
      }));
      await commit(next => {
        next.openingCents = openingCents;
        next.etsyDeposits = etsyDeposits;
        next.paychecks = paychecks;
      });
    } catch (cause) {
      form.querySelector('.schedule-editor-error').textContent = cause.message;
    }
    return;
  }
  try {
    if (form.id === 'add-bill') {
      const name = String(fields.get('name')).trim(), amountCents = toCents(fields.get('amount')), endOfMonth = fields.has('eom');
      const day = endOfMonth ? daysInMonth(selectedMonth) : validateDay(fields.get('day'), selectedMonth);
      if (!name) throw new Error('Enter a bill name.');
      await commit(next => next.bills.push({ id: id(), name, day, amountCents, endOfMonth, paid: false }));
    }
    if (form.id === 'add-pay') {
      const name = String(fields.get('name')).trim(), day = validateDay(fields.get('day'), selectedMonth), amountCents = toCents(fields.get('amount'));
      if (!name) throw new Error('Enter a paycheck name.');
      await commit(next => next.paychecks.push({ id: id(), name, day, amountCents, received: false }));
    }
  } catch (cause) { const input = form.querySelector('input'); input.setCustomValidity(cause.message); input.reportValidity(); }
});
root.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'open-charge-dialog') {
    root.querySelector('#charge-dialog-' + button.dataset.card).showModal();
    return;
  }
  if (action === 'close-charge-dialog') {
    button.closest('dialog').close();
    return;
  }
  if (action === 'add-charge-group') {
    if (!queueCharge(button.form)) return;
    const group = root.querySelector('#charge-draft-group').content.firstElementChild.cloneNode(true);
    group.append(button.form.querySelector('.charge-draft-editor'));
    button.form.querySelector('.charge-batch-groups').append(group);
    group.querySelector('[name="posted"]').focus();
    return;
  }
  if (action === 'queue-charge') {
    if (queueCharge(button.form, true)) button.form.elements.vendor.focus();
    return;
  }
  if (action === 'edit-charge-draft') {
    if (button.getAttribute('aria-pressed') === 'true' || !queueCharge(button.form)) return;
    setChargeEditor(button.form, button);
    button.form.elements.vendor.focus();
    return;
  }
  if (action === 'remove-charge-draft') {
    const form = button.form;
    form.querySelector('.charge-draft-item[aria-pressed="true"]').remove();
    setChargeEditor(form);
    form.elements.vendor.focus();
    return;
  }
  if (action === 'select-card') return selectCard(button.dataset.card);
  if (action === 'edit-charges') {
    button.form.classList.add('is-editing');
    button.form.querySelector('tbody select')?.focus();
    return;
  }
  if (action === 'cancel-charge-edits') {
    const form = button.form;
    form.reset();
    for (const row of form.querySelectorAll('tr[hidden]')) row.hidden = false;
    form.querySelector('.schedule-editor-error').textContent = '';
    form.classList.remove('is-editing');
    form.querySelector('[data-action="edit-charges"]').focus();
    return;
  }
  if (action === 'stage-charge-removal') {
    const row = button.closest('tr');
    row.hidden = true;
    button.form.querySelector('[type="submit"]').focus();
    return;
  }
  if (action === 'edit-schedule') {
    button.form.classList.add('is-editing');
    button.form.querySelector('input').focus();
    return;
  }
  if (action === 'cancel-schedule') {
    const form = button.form;
    form.reset();
    form.querySelector('.schedule-editor-error').textContent = '';
    form.classList.remove('is-editing');
    form.querySelector('[data-action="edit-schedule"]').focus();
    return;
  }
  if (action === 'load-paycheck-template') {
    if (!budget || busy || budget.closed) return;
    if (!confirm('Replace this month’s paycheck rows with the C/A template? Any unsaved schedule edits will be discarded.')) return;
    return commit(next => { next.paychecks = createMonth(next.month).paychecks; });
  }
  if (action === 'retry') return persist();
  if (action === 'reload') { if (dirty && !confirm('Discard unsaved changes and reload the saved month?')) return; return repository ? loadMonth() : start(null); }
  if (action === 'sign-out') { const { error: cause } = await supabase.auth.signOut(); if (cause) { error = cause.message; render(); } else await start(null); return; }
  if (action === 'remove-bill') return commit(next => { next.bills = next.bills.filter(b => b.id !== button.dataset.id); });
  if (action === 'statement-paid') return commit(next => { next.statement.paid = !next.statement.paid; });
  if (action === 'close') return commit(next => { next.closed = !next.closed; }, true);
  if (action === 'defaults') {
    busy = true; error = ''; render();
    try { const record = await repository.savePreferences(preferencesFromMonth(budget), preferencesRevision); preferences = record.document; preferencesRevision = record.revision; notice = 'Future defaults updated'; }
    catch (cause) { error = cause.message; }
    finally { busy = false; render(); }
  }
  if (action === 'export') {
    const link = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(budget, null, 2)], { type: 'application/json' }));
    link.href = url; link.download = `m-app-${selectedMonth}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
if (supabase) {
  supabase.auth.getSession().then(({ data, error: cause }) => { if (cause) { error = cause.message; loading = false; renderAuth(); } else start(data.session); });
  supabase.auth.onAuthStateChange((_event, session) => { if ((session?.user?.id ?? null) !== (activeUser?.id ?? null)) setTimeout(() => start(session), 0); });
} else start(null);
