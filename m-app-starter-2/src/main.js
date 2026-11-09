import './styles.css';
import './schedule.css';
import { CATEGORIES, copy, id, money, currentMonth, validMonth, daysInMonth, monthLabel, shortMonth, toCents, parsePostedDate, displayDate, validateDay, emptyPreferences, createMonth, hasLegacyPaycheckDefaults, preferencesFromMonth, sortedCharges, totals, compactSchedule, etsyDepositDays } from './budget.js';
import { createLocalRepository, createCloudRepository } from './repository.js';
import { supabase } from './supabase.js';

const root = document.getElementById('app');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let selectedMonth = currentMonth();
let budget = null, revision = 0, preferences = emptyPreferences(), preferencesRevision = 0;
let repository = null, activeUser = null, busy = false, dirty = false, error = '', notice = '', loading = true, loadToken = 0;
const disabled = () => busy || budget?.closed ? 'disabled' : '';
const negative = value => value < 0 ? 'negative' : '';
const amount = value => (value / 100).toFixed(2);
const optionList = selected => CATEGORIES.map(category => `<option ${selected === category ? 'selected' : ''}>${esc(category)}</option>`).join('');

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
function cardMarkup() {
  let pendingSeen = false;
  const rows = sortedCharges(budget.charges).map(charge => {
    const divider = !charge.postedDate && !pendingSeen ? '<tr class="pending-heading"><td colspan="4">Pending</td></tr>' : '';
    if (!charge.postedDate) pendingSeen = true;
    return `${divider}<tr class="charge-row"><td class="charge-date"><label><span class="mobile-label">Date posted</span><input type="text" class="posted-date" value="${esc(displayDate(charge.postedDate))}" placeholder="MM/DD/YY" maxlength="10" autocomplete="off" aria-label="${esc(charge.vendor)} date posted; blank means pending" data-kind="charge-date" data-id="${charge.id}" ${disabled()}></label></td><td class="charge-vendor">${esc(charge.vendor)}<button class="text-button remove-charge" type="button" data-action="remove-charge" data-id="${charge.id}" aria-label="Remove ${esc(charge.vendor)} charge" ${disabled()}>Remove</button></td><td class="charge-amount">${amountField(charge.amountCents, `${charge.vendor} amount in dollars`, 'charge-amount', charge.id)}</td><td class="charge-category"><label><span class="mobile-label">Category</span><select data-kind="charge-category" data-id="${charge.id}" aria-label="${esc(charge.vendor)} category" ${disabled()}>${optionList(charge.category)}</select></label></td></tr>`;
  }).join('');
  const t = totals(budget);
  return `<section class="panel card-panel"><div class="panel-heading"><div><h2>Credit card activity</h2><p>Posted newest first · pending at bottom</p></div><span class="pill">${esc(shortMonth(selectedMonth))}</span></div><div class="card-totals"><div>Posted<strong>${money(t.posted)}</strong></div><div>Pending<strong>${money(t.pending)}</strong></div><div>Total reserved<strong>${money(t.reserved)}</strong></div></div><table class="card-table"><thead><tr><th>Date posted</th><th>Vendor</th><th class="numeric">Amount ($)</th><th>Category</th></tr></thead><tbody>${rows || '<tr class="empty-row"><td colspan="4">No card activity entered for this month.</td></tr>'}</tbody></table><form id="add-charge" class="charge-form"><label>Date posted<input name="posted" type="text" placeholder="MM/DD/YY" maxlength="10" autocomplete="off" ${disabled()}></label><label>Vendor<input name="vendor" placeholder="New charge" maxlength="160" required ${disabled()}></label><label>Amount ($)<input name="amount" inputmode="decimal" placeholder="0.00" required ${disabled()}></label><label>Category<select name="category" ${disabled()}>${optionList('Uncategorized')}</select></label><button class="primary" ${disabled()}>Add</button></form><p class="hint">Blank date = pending. Enter a date as MM/DD/YY to post. Use a negative amount for a refund.</p><details class="statement"><summary>Previous statement payment · ${money(budget.statement.amountCents)}</summary><div class="statement-fields"><label>Balance ($)${amountField(budget.statement.amountCents, 'Previous statement balance', 'statement-amount')}</label><label>Pay on ${esc(shortMonth(selectedMonth))}<input type="number" min="1" max="${daysInMonth(selectedMonth)}" value="${budget.statement.paymentDay}" data-kind="statement-day" ${disabled()}></label><label>Due ${esc(shortMonth(selectedMonth))}<input type="number" min="1" max="${daysInMonth(selectedMonth)}" value="${budget.statement.dueDay}" data-kind="statement-due" ${disabled()}></label></div><button data-action="statement-paid" type="button" ${disabled()} ${!budget.statement.amountCents ? 'disabled' : ''}>${budget.statement.paid ? 'Undo paid' : 'Mark payment cleared'}</button><p class="hint">This payment covers the previous statement. New charges above are reserved separately.</p></details></section>`;
}
function billsMarkup() {
  const rows = budget.bills.slice().sort((a, b) => a.day - b.day).map(bill => `<tr><td class="bill-day"><label class="day-label"><span>${esc(shortMonth(selectedMonth))}</span><input type="number" min="1" max="${daysInMonth(selectedMonth)}" value="${bill.day}" data-kind="bill-day" data-id="${bill.id}" aria-label="${esc(bill.name)} debit day" ${disabled()}></label></td><td class="bill-name">${esc(bill.name)}${bill.endOfMonth ? '<span class="hint">End of month</span>' : ''}</td><td class="bill-amount">${amountField(bill.amountCents, `${bill.name} amount`, 'bill-amount', bill.id)}</td><td class="bill-paid"><label class="paid-label"><span class="mobile-label">Paid</span><input type="checkbox" data-kind="bill-paid" data-id="${bill.id}" aria-label="${esc(bill.name)} paid" ${bill.paid ? 'checked' : ''} ${disabled()}></label></td></tr>`).join('');
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
  loading = true; error = ''; budget = null; dirty = false; render();
  try {
    const record = await repository.loadMonth(selectedMonth);
    if (token !== loadToken) return;
    budget = record ? copy(record.document) : createMonth(selectedMonth, preferences);
    if (record && !budget.closed && hasLegacyPaycheckDefaults(budget.paychecks)) {
      budget.paychecks = createMonth(selectedMonth).paychecks;
    }
    revision = record?.revision ?? 0;
  } catch (cause) { if (token === loadToken) error = cause.message; }
  finally { if (token === loadToken) { loading = false; render(); } }
}
async function start(session) {
  activeUser = session?.user ?? null;
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
  try {
    const record = await repository.saveMonth(copy(budget), revision);
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
root.addEventListener('input', event => event.target.setCustomValidity?.(''));
root.addEventListener('keydown', event => {
  const input = event.target;
  if (event.key === 'Enter' && input.matches('input[data-kind]:not([type="checkbox"])')) { event.preventDefault(); input.dispatchEvent(new Event('change', { bubbles: true })); }
});
root.addEventListener('change', async event => {
  const input = event.target, kind = input.dataset.kind, rowId = input.dataset.id;
  if (!kind) return;
  try {
    if (kind === 'month') { if (busy || dirty || !validMonth(input.value)) return; selectedMonth = input.value; notice = ''; await loadMonth(); return; }
    if (busy || budget?.closed) return;
    const isAmount = ['bill-amount', 'charge-amount', 'statement-amount'].includes(kind);
    const cents = isAmount ? toCents(input.value, kind === 'charge-amount') : null;
    const day = ['bill-day', 'statement-day', 'statement-due'].includes(kind) ? validateDay(input.value, selectedMonth) : null;
    const posted = kind === 'charge-date' ? parsePostedDate(input.value) : null;
    await commit(next => {
      if (kind === 'bill-amount') rowById(next.bills, rowId).amountCents = cents;
      if (kind === 'bill-day') { const bill = rowById(next.bills, rowId); bill.day = day; bill.endOfMonth = day === daysInMonth(selectedMonth) && bill.endOfMonth; }
      if (kind === 'bill-paid') rowById(next.bills, rowId).paid = input.checked;
      if (kind === 'charge-date') rowById(next.charges, rowId).postedDate = posted;
      if (kind === 'charge-amount') rowById(next.charges, rowId).amountCents = cents;
      if (kind === 'charge-category') rowById(next.charges, rowId).category = input.value;
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
    if (form.id === 'add-charge') {
      const postedDate = parsePostedDate(fields.get('posted')), amountCents = toCents(fields.get('amount'), true), vendor = String(fields.get('vendor')).trim();
      if (!vendor || !amountCents) throw new Error('Enter a vendor and a nonzero amount.');
      await commit(next => next.charges.push({ id: id(), vendor, amountCents, postedDate, category: fields.get('category') }));
    }
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
  if (action === 'remove-charge') return commit(next => { next.charges = next.charges.filter(c => c.id !== button.dataset.id); });
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
