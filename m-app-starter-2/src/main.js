import './styles.css';
import './schedule.css';
import { CATEGORIES, CC_CATEGORY_CODES, CARDS, cardStatementCycle, cardStatementPayments, copy, id, money, currentMonth, validMonth, daysInMonth, monthLabel, shortMonth, toCents, parsePostedDate, displayDate, validateDay, emptyPreferences, createMonth, hasLegacyPaycheckDefaults, preferencesFromMonth, sortedCharges, totals, compactSchedule, etsyDepositDays } from './budget.js';
import { createLocalRepository, createCloudRepository } from './repository.js';
import { supabase } from './supabase.js';
import { connectMonthNavigation, monthNavigationMarkup } from './month-navigation.js';


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
function panelEditButton(action, label, stateClass) {
  return `<button type="button" class="panel-edit-button ${stateClass}" data-action="${action}" aria-label="${label}" title="${label}" ${disabled()}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m14.5 5.5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z"/>
    </svg>
  </button>`;
}
function panelAddButton(dialogId, label) {
  return `<button type="button" class="panel-add-button" data-action="open-item-dialog" aria-label="${label}" aria-haspopup="dialog" aria-controls="${dialogId}" ${disabled()}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
  </button>`;
}
function optionList(selected, compact = false) {
  const options = [['', 'Uncategorized'], ...Object.entries(CC_CATEGORY_CODES)];
  if (selected && !CATEGORIES.includes(selected)) options.push(['', selected]);
  return options.map(([code, category]) => {
    const label = code || compact ? (code || '—') + ' · ' + category : category;
    return `<option value="${esc(category)}" ${selected === category ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
}
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

function renderAuth() {
  root.innerHTML = `<main class="auth"><div class="wordmark">m.</div><h1>Your month, reconciled.</h1><p>Sign in to open your paycheck schedule, bills, and card activity.</p>${error ? `<p role="alert" class="error">${esc(error)}</p>` : ''}<form id="sign-in"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Signing in…' : 'Sign in'}</button></form></main>`;
}
function scheduleItemDialogMarkup(lastDay) {
  if (budget.closed) return '';
  const dateLimits = `min="${selectedMonth}-01" max="${selectedMonth}-${lastDay}"`;
  const actions = label => `<div class="schedule-item-actions">
    <button type="button" data-action="choose-schedule-item" data-item="choice">Back</button>
    <button class="primary" type="submit" ${disabled()}>${label}</button>
  </div>
  <div role="alert" class="schedule-editor-error"></div>`;
  return `${panelAddButton('schedule-item-dialog', 'Add a schedule item')}
  <dialog id="schedule-item-dialog" class="schedule-item-dialog" aria-labelledby="schedule-item-title">
    <div class="schedule-item-heading">
      <h3 id="schedule-item-title" tabindex="-1">Add to schedule</h3>
      <button type="button" data-action="close-item-dialog" aria-label="Close schedule dialog">×</button>
    </div>
    <div class="schedule-item-choices" data-schedule-item-view="choice">
      <button type="button" data-action="choose-schedule-item" data-item="income">+ Income</button>
      <button type="button" data-action="choose-schedule-item" data-item="savings">+ Savings</button>
    </div>
    <form id="add-pay" class="inline-form schedule-item-form" data-schedule-item-view="income" hidden>
      <label>Name<input name="name" required maxlength="80" placeholder="Income name"></label>
      <label>Date<input name="date" type="date" ${dateLimits} required></label>
      <label>Amount ($)<input name="amount" inputmode="decimal" placeholder="0.00" required></label>
      ${actions('Add income')}
    </form>
    <form id="add-savings" class="inline-form schedule-item-form" data-schedule-item-view="savings" hidden>
      <label>Type<select name="direction"><option value="to-savings">Transfer to savings</option><option value="from-savings">Withdraw from savings</option></select></label>
      <label>Date<input name="date" type="date" ${dateLimits} required></label>
      <label>Amount ($)<input name="amount" inputmode="decimal" placeholder="0.00" required></label>
      ${actions('Add transfer')}
    </form>
  </dialog>`;
}
function scheduleMarkup() {
  const monthNumber = Number(selectedMonth.slice(5));
  const lastDay = daysInMonth(selectedMonth);
  const schedule = compactSchedule(budget);
  const scheduledBills = schedule.reduce((total, row) =>
    row.expenseType === 'bill' ? total - row.amountCents : total, 0);
  const checkingBills = budget.bills.reduce((total, bill) => total + bill.amountCents, 0);
  const billsMatch = scheduledBills === checkingBills;
  const billDialogs = [];
  let firstBillDay = 1;
  const hasBothPayTypes = ['C pay', 'A pay'].every(name => budget.paychecks.some(pay => pay.name === name));
  const rows = schedule.map((row, index) => {
    const label = row.kind === 'opening' ? 'Checking Start' : row.label;
    const balanceClass = row.kind === 'opening' || row.kind === 'balance' ? 'schedule-balance' : '';
    const rowClass = index === schedule.length - 1 ? 'schedule-ending' : balanceClass;
    const rowType = row.expenseType ?? row.kind;
    const amountClass = row.kind === 'savings' ? '' : negative(row.amountCents);
    let date = `${monthNumber}/${row.day}`;
    let amountName = '';
    if (row.kind === 'opening') amountName = 'opening';
    if (row.kind === 'etsy') amountName = 'etsy-' + row.day;
    if (row.kind === 'pay') {
      const paycheckIndex = budget.paychecks.indexOf(row.pay);
      const name = esc(row.pay.name);
      amountName = 'amount-' + paycheckIndex;
      date = `<span class="schedule-view-value">${date}</span>
        <span class="schedule-edit-controls schedule-date-input">${monthNumber}/<input name="day-${paycheckIndex}" aria-label="${name} day of month" type="number" min="1" max="${lastDay}" value="${row.day}" required></span>`;
    }
    const isNegative = row.amountCents < 0;
    const currency = money(Math.abs(row.amountCents));
    const formattedAmount = isNegative ? `(${currency})` : currency;
    const alignedAmount = `${isNegative ? '(' : ''}${currency.slice(0, -2)}<span class="schedule-amount-cents">${currency.slice(-2)}</span><span class="schedule-amount-suffix">${isNegative ? ')' : ''}</span>`;
    let displayedAmount = alignedAmount;
    if (amountName) {
      const amountLabel = row.kind === 'etsy' ? `${date} ${label}` : label;
      displayedAmount = `<span class="schedule-view-value">${displayedAmount}</span>
        <input class="schedule-edit-controls schedule-amount-input" name="${amountName}" aria-label="${esc(amountLabel)} amount in dollars" inputmode="decimal" value="${amount(row.amountCents)}" ${row.kind === 'etsy' ? '' : 'required'}>`;
    }
    if (row.expenseType === 'bill' && row.label === 'Bills' && row.day >= firstBillDay) {
      // Older versions of budget.js only provide the subtotal and its cutoff day.
      const bills = row.bills ?? budget.bills.filter(bill =>
        !bill.endOfMonth && bill.day >= firstBillDay && bill.day <= row.day
      ).sort((a, b) => a.day - b.day);
      firstBillDay = row.day + 1;
      const dialogId = 'schedule-bills-' + index;
      displayedAmount = `<button type="button" class="schedule-bill-trigger" data-action="open-bill-breakdown"
        aria-haspopup="dialog" aria-controls="${dialogId}" aria-label="View bills through ${date}, subtotal ${formattedAmount}">${alignedAmount}</button>`;
      billDialogs.push(`<dialog id="${dialogId}" class="schedule-item-dialog" aria-labelledby="${dialogId}-title">
        <div class="schedule-item-heading">
          <h3 id="${dialogId}-title">Bills through ${date}</h3>
          <button type="button" data-action="close-item-dialog" aria-label="Close bill details">×</button>
        </div>
        ${bills.length ? `<ul class="schedule-bill-breakdown">${bills.map(bill => `<li>
          <span>${monthNumber}/${bill.day}</span>
          <span>${esc(bill.name)}</span>
          <span class="numeric">${money(bill.amountCents)}</span>
        </li>`).join('')}</ul>` : '<p class="hint">No bills in this group.</p>'}
        <p class="numeric"><strong>Total ${money(Math.abs(row.amountCents))}</strong></p>
      </dialog>`);
    }
    return `<tr class="${rowClass} schedule-type-${rowType}">
      <td class="schedule-date">${date}</td>
      <th scope="row"><span class="schedule-description" title="${esc(label)}">${esc(label)}</span></th>
      <td class="numeric ${amountClass}">${displayedAmount}</td>
    </tr>`;
  }).join('');
  const lastDate = `${selectedMonth}-${lastDay}`;
  const savingsEditors = (budget.savingsTransfers ?? []).map((transfer, index) => {
    const date = `${selectedMonth}-${String(transfer.day).padStart(2, '0')}`;
    return `<div class="schedule-savings-transfer" data-savings-editor>
      <div class="schedule-savings-heading">
        <strong>${transfer.amountCents < 0 ? 'To savings' : 'From savings'}</strong>
        <button type="button" data-action="toggle-savings-removal">Remove</button>
        <input type="checkbox" name="remove-savings-${index}" hidden>
      </div>
      <fieldset class="schedule-savings-fields" aria-label="Savings transfer details">
        <label>Date<input name="savings-date-${index}" type="date" min="${selectedMonth}-01" max="${lastDate}" value="${date}" required></label>
        <label>Amount ($)<input name="savings-amount-${index}" inputmode="decimal" value="${amount(Math.abs(transfer.amountCents))}" required></label>
      </fieldset>
    </div>`;
  }).join('');

  return `<section class="panel schedule-panel">
    <form id="edit-schedule">
    <div class="panel-heading">
      <h2>Monthly schedule</h2>
      ${budget.closed ? '<span class="pill">Closed</span>' : `${panelEditButton('edit-schedule', 'Edit monthly schedule', 'schedule-view-value')}
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
    <p class="schedule-bill-check${billsMatch ? '' : ' is-mismatch'}">
      ${billsMatch
        ? `<span aria-hidden="true">✓</span> Checking bills match · ${money(checkingBills)}`
        : `Bills differ · ${money(scheduledBills)} scheduled / ${money(checkingBills)} in Checking bills`}
    </p>
    ${savingsEditors ? `<section class="schedule-edit-controls schedule-savings-editor" aria-label="Edit savings transfers">
      <h3>Savings transfers</h3>
      ${savingsEditors}
    </section>` : ''}
    </form>
    ${billDialogs.join('')}
    ${scheduleItemDialogMarkup(lastDay)}
  </section>`;
}
function cardChargeTable(charges, scope) {
  if (!charges.length) return '<p class="hint">No card activity entered for this month.</p>';
  const rows = sortedCharges(charges).map((charge, index, orderedCharges) => {
    const key = esc(charge.id);
    const vendor = esc(charge.vendor);
    const code = Object.entries(CC_CATEGORY_CODES).find(([, category]) => category === charge.category)?.[0] ?? '—';
    const date = displayDate(charge.postedDate);
    const dateChanged = index > 0 && (charge.postedDate ?? '') !== (orderedCharges[index - 1].postedDate ?? '');
    const rowClass = [
      dateChanged ? 'charge-date-divider' : '',
      charge.important === true ? 'charge-important' : '',
      charge.amountCents < 0 ? 'charge-refund' : '',
    ].filter(Boolean).join(' ');
    const edit = budget.closed ? [] : [
      `<div class="charge-code-edit">
        <select name="category-${key}" data-category-code aria-label="Category code for ${vendor}">${optionList(charge.category, true)}</select>
        <label class="charge-important-toggle" title="Important"><input type="checkbox" name="important-${key}" aria-label="Mark ${vendor} important" ${charge.important === true ? 'checked' : ''}><span aria-hidden="true">★</span></label>
      </div>`,
      `<input name="vendor-${key}" value="${vendor}" list="card-vendor-history" maxlength="160" aria-label="Vendor for ${vendor}">`,
      `<input name="posted-${key}" value="${esc(date)}" placeholder="Pending" maxlength="10" aria-label="Date for ${vendor}">`,
      `<input name="amount-${key}" value="${amount(charge.amountCents)}" inputmode="decimal" aria-label="Amount for ${vendor}">`,
    ];
    const cell = (value, index) => `<span class="charge-list-view">${value}</span>${edit[index] ? `<div class="charge-list-edit">${edit[index]}</div>` : ''}`;
    return `<tr data-charge-id="${key}" data-charge-code="${code}" class="${rowClass}">
      <td><span class="charge-list-view" title="${esc(charge.category)}">${code}</span>${edit[0] ? `<div class="charge-list-edit">${edit[0]}</div>` : ''}</td>
      <td title="${vendor}">${cell(vendor, 1)}</td>
      <td class="numeric">${cell(esc(money(charge.amountCents)), 3)}</td>
      <td>${cell(esc(date || 'Pending'), 2)}</td>
      ${budget.closed ? '' : `<td class="charge-list-edit charge-remove-cell"><button class="charge-remove-button" type="button" data-action="stage-charge-removal" aria-label="Remove ${vendor}">−</button></td>`}
    </tr>`;
  }).join('');
  return `<form class="charge-list" data-charge-scope="${scope}">
    ${budget.closed ? '' : `<div class="charge-list-actions">
      ${scope ? panelEditButton('edit-charges', 'Edit card charges', 'charge-list-view') : `<button class="charge-list-view" type="button" data-action="edit-charges" ${disabled()}>Edit charges</button>`}
      <div class="charge-list-edit">
        <button class="primary" type="submit" ${disabled()}>Save changes</button>
        <button type="button" data-action="cancel-charge-edits" ${disabled()}>Cancel</button>
      </div>
    </div>`}
    <div class="charge-list-scroll" role="region" aria-label="Saved charges" tabindex="0"><table class="charge-list-table">
      <thead><tr><th scope="col">Code</th><th scope="col">Vendor</th><th scope="col" class="numeric">Amt</th><th scope="col">Date</th>${budget.closed ? '' : '<th scope="col" class="charge-list-edit charge-remove-cell" aria-label="Remove"></th>'}</tr></thead>
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
      <div class="card-cycle">
        <p class="hint">${card.name} statement cycle · ${displayDate(cycle.from)} to ${displayDate(cycle.until)}</p>
        <p class="hint">${money(payment.amountCents)} due <time datetime="${selectedMonth}-${String(card.dueDay).padStart(2, '0')}">${shortMonth(selectedMonth)} ${card.dueDay}</time></p>
      </div>
      <div class="card-totals">
        <div>Posted<strong>${money(posted)}</strong></div>
        <div>Pending<strong>${money(pending)}</strong></div>
        <div>Total<strong>${money(posted + pending)}</strong></div>
      </div>
      ${cardChargeTable(charges, card.id)}
      ${budget.closed ? '' : `<dialog id="charge-dialog-${card.id}" class="charge-dialog" aria-labelledby="charge-dialog-title-${card.id}">
        <h3 id="charge-dialog-title-${card.id}">Add ${card.name} charges</h3>
        <form id="add-charges-${card.id}" class="charge-batch-form">
          <label class="charge-batch-date">Date posted
            <input name="posted" placeholder="MM/DD or Pending" maxlength="10" autocomplete="off" ${disabled()}>
          </label>
          <p class="hint">This date applies to all charges in this batch. Leave it blank for pending charges.</p>
          ${draftEditor}
          <div class="charge-draft-list"></div>
          <p role="status"><strong class="charge-batch-total">Batch total · 0 charges · ${money(0)}</strong></p>
          <div class="charge-batch-actions">
            <button type="button" data-action="close-charge-dialog">Close</button>
            <button type="submit" class="primary" ${disabled()}>Save all charges</button>
          </div>
          <div role="alert" class="schedule-editor-error"></div>
        </form>
      </dialog>`}
    </div>`;
  }).join('');
  return `<section class="panel card-panel">
    <div class="panel-heading card-panel-heading"><h2>CREDIT CARD ACTIVITY</h2></div>
    <div class="card-tabs" role="tablist" aria-label="Credit cards">${tabs}</div>
    ${panels}
    <datalist id="card-vendor-history">${knownVendors.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>
    ${unassigned.length ? `<details class="statement"><summary>Unassigned charges (${unassigned.length})</summary>${cardChargeTable(unassigned, '')}</details>` : ''}
    ${budget.closed ? '' : `<button type="button" class="primary charge-add-button" data-action="open-charge-dialog" aria-haspopup="dialog" ${disabled()}>+ Add charges</button>`}
  </section>`;
}
function billsMarkup() {
  const lastDay = daysInMonth(selectedMonth);
  const debitDayOptions = Array.from({ length: lastDay }, (_, index) => {
    const day = index + 1;
    return `<option value="${day}">${day}</option>`;
  }).join('');
  const bills = budget.bills.slice().sort((a, b) => a.day - b.day);
  const subtotal = bills.reduce((total, bill) => total + bill.amountCents, 0);
  const debitDate = bill => `${Number(selectedMonth.slice(5))}/${bill.day}`;
  const rows = bills.map(bill => {
    const key = esc(bill.id);
    const name = esc(bill.name);
    return `<li data-bill-id="${key}">
      <div class="bill-summary">
        <span class="bill-summary-date">${bill.endOfMonth ? '<abbr title="End of month">EOM</abbr>' : debitDate(bill)}</span>
        <span class="bill-summary-name" title="${name}">${name}</span>
        <span class="bill-summary-amount">${money(bill.amountCents)}</span>
        <label class="bill-paid-field"><input type="checkbox" id="bill-paid-${key}" data-kind="bill-paid" data-id="${key}" aria-label="Mark ${name} paid" ${bill.paid ? 'checked' : ''} ${disabled()}></label>
      </div>
      ${budget.closed ? '' : `<div class="bill-fields">
        <input type="number" name="day-${key}" min="1" max="${lastDay}" value="${bill.day}" aria-label="Debit day for ${name}" ${disabled()}>
        <input name="name-${key}" value="${name}" maxlength="100" aria-label="Vendor for ${name}" ${disabled()}>
        <input name="amount-${key}" inputmode="decimal" value="${amount(bill.amountCents)}" aria-label="Amount for ${name}" ${disabled()}>
        <label class="bill-paid-field"><input type="checkbox" name="paid-${key}" aria-label="Mark ${name} paid" ${bill.paid ? 'checked' : ''} ${disabled()}></label>
        <button type="button" class="bill-remove-button" data-action="stage-bill-removal" aria-label="Remove ${name}" ${disabled()}>−</button>
      </div>`}
    </li>`;
  }).join('');
  return `<section class="panel bills-panel">
    <form id="edit-bills" novalidate>
      <div class="panel-heading">
        <div><h2>Checking bills</h2><p class="hint">${bills.filter(bill => bill.paid).length} of ${bills.length} paid · ${money(subtotal)} total · ${money(totals(budget).remainingBills)} still to clear</p></div>
        ${!budget.closed && rows ? panelEditButton('edit-bills', 'Edit checking bills', 'bill-edit-button') : ''}
      </div>
      ${rows ? `<ul class="bill-list">${rows}</ul>` : '<p class="hint">No bills for this month.</p>'}
      <div role="alert" class="schedule-editor-error"></div>
      ${!budget.closed && rows ? `<div class="bill-edit-actions">
        <button type="button" data-action="cancel-bill-edits" ${disabled()}>Cancel</button>
        <button type="submit" class="primary" ${disabled()}>Save changes</button>
      </div>` : ''}
    </form>
    ${budget.closed ? '' : `${panelAddButton('bill-item-dialog', 'Add a bill')}
    <dialog id="bill-item-dialog" class="schedule-item-dialog" aria-labelledby="bill-item-title">
      <div class="schedule-item-heading">
        <h3 id="bill-item-title">Add a bill</h3>
        <button type="button" data-action="close-item-dialog" aria-label="Close bill dialog">×</button>
      </div>
      <form id="add-bill" class="inline-form schedule-item-form">
        <label>Bill name<input name="name" maxlength="100" placeholder="Mortgage, water…" required ${disabled()}></label>
        <label>Debit day<select name="day" ${disabled()}>${debitDayOptions}<option value="eom">End of month</option></select></label>
        <label>Amount ($)<input name="amount" inputmode="decimal" placeholder="0.00" required ${disabled()}></label>
        <div class="schedule-item-actions">
          <button type="button" data-action="close-item-dialog">Cancel</button>
          <button class="primary" type="submit" ${disabled()}>Add bill</button>
        </div>
        <div role="alert" class="schedule-editor-error"></div>
      </form>
    </dialog>`}
  </section>`;
}
function render() {
  if (supabase && !activeUser) return renderAuth();
  if (!budget) { root.innerHTML = `<main class="auth"><div class="wordmark">m.</div><p>${loading ? 'Opening your month…' : esc(error || 'Could not open your budget.')}</p>${!loading ? '<button data-action="reload">Try again</button>' : ''}</main>`; return; }
  const t = totals(budget);
  const tileScroll = root.querySelector('.workspace')?.scrollLeft ?? 0;
  root.innerHTML = `<div class="app-shell"><header><div class="topline"><div class="brand">m.</div><div class="account">${supabase ? `<button data-action="sign-out" ${busy || dirty ? 'disabled' : ''}>Sign out</button>` : '<span>Stored on this device</span>'}</div></div>${monthNavigationMarkup(selectedMonth, busy || dirty)}<div class="save-line" role="status">${busy ? 'Saving…' : dirty ? 'Changes need to be saved' : supabase ? 'Saved to your account' : 'Saved on this device'}${notice ? ` · ${esc(notice)}` : ''}</div></header>${error ? `<div class="error-banner" role="alert"><p>${esc(error)}</p><div>${dirty ? '<button data-action="retry">Retry save</button>' : ''}<button data-action="reload">Reload saved version</button></div></div>` : ''}<main class="workspace">${scheduleMarkup()}<div class="ledgers">${cardMarkup()}${billsMarkup()}</div></main><footer><div>${t.lowest < 0 ? '<span class="negative">A scheduled balance falls below zero.</span>' : 'Every scheduled balance stays at or above zero.'}</div><details><summary>Month options</summary><div class="footer-actions"><button data-action="defaults" ${busy || dirty || budget.closed ? 'disabled' : ''}>Use bills & paychecks as future defaults</button><button data-action="export" ${busy ? 'disabled' : ''}>Export this month</button><button data-action="close" ${busy || dirty ? 'disabled' : ''}>${budget.closed ? 'Reopen month' : 'Close month'}</button></div><p class="hint">All edits belong to ${esc(monthLabel(selectedMonth))}. Future defaults only populate months you have not opened yet.</p></details></footer></div>`;
  root.querySelector('.workspace').scrollLeft = tileScroll;
  scrollToLatestCharges();
}
function scrollToLatestCharges() {
  for (const list of root.querySelectorAll('.card-tab-panel:not([hidden]) .charge-list-scroll')) {
    list.scrollTop = list.scrollHeight;
  }
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
function scheduleItemDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== selectedMonth) {
    throw new Error('Choose a date in the selected month.');
  }
  return validateDay(date.slice(8), selectedMonth);
}
function setScheduleItemView(dialog, view) {
  const title = dialog.querySelector('#schedule-item-title');
  title.textContent = { choice: 'Add to schedule', income: 'Add income', savings: 'Add savings' }[view];
  for (const panel of dialog.querySelectorAll('[data-schedule-item-view]')) {
    panel.hidden = panel.dataset.scheduleItemView !== view;
  }
  if (dialog.open) title.focus();
}
function setSavingsRemoval(editor, removed) {
  editor.querySelector('input[type="checkbox"]').checked = removed;
  editor.querySelector('fieldset').disabled = removed;
  editor.querySelector('button').textContent = removed ? 'Undo remove' : 'Remove';
}
function parseCardDate(value) {
  return parsePostedDate(value, selectedMonth.slice(0, 4));
}
const queuedCharges = new WeakMap();
function updateChargeTotals(form) {
  const rows = Array.from(form.querySelectorAll('.charge-draft-item'));
  const cents = rows.reduce((sum, row) => sum + queuedCharges.get(row).amountCents, 0);
  const count = rows.length;
  form.querySelector('.charge-batch-total').textContent = `Batch total · ${count} ${count === 1 ? 'charge' : 'charges'} · ${money(cents)}`;
}
function setChargeEditor(form, row = null) {
  const editor = form.querySelector('.charge-draft-editor');
  form.querySelector('.charge-draft-item[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
  const charge = queuedCharges.get(row);
  if (row) row.setAttribute('aria-pressed', 'true');
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
      form.querySelector('.charge-draft-list').append(row);
    }
    const code = Object.entries(CC_CATEGORY_CODES).find(([, name]) => name === category)?.[0];
    row.textContent = [code, vendor, money(amountCents)].filter(Boolean).join(' · ');
    row.classList.toggle('charge-important', important);
    queuedCharges.set(row, { vendor, amountCents, category, important });
    updateChargeTotals(form);
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
  scrollToLatestCharges();
}
root.addEventListener('touchstart', event => {
  cardTouchStart = null;
  if (window.matchMedia('(max-width: 759px)').matches) return;
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
connectMonthNavigation(root, async month => {
  if (!budget || busy || dirty || !validMonth(month) || month === selectedMonth) return false;
  selectedMonth = month;
  notice = '';
  await loadMonth();
  return Boolean(budget) && selectedMonth === month;
});
root.addEventListener('change', async event => {
  const input = event.target;
  if (input.dataset.kind !== 'bill-paid' || busy || budget?.closed) return;
  try {
    const billId = input.dataset.id;
    const paid = input.checked;
    await commit(next => { rowById(next.bills, billId).paid = paid; });
    document.getElementById('bill-paid-' + billId)?.focus?.({ preventScroll: true });
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
  if (form.id === 'edit-bills') {
    if (!form.classList.contains('is-editing')) return;
    const message = form.querySelector('.schedule-editor-error');
    message.textContent = '';
    const removed = new Set(Array.from(form.querySelectorAll('li[data-bill-id][hidden]'), row => row.dataset.billId));
    const lastDay = daysInMonth(selectedMonth);
    try {
      const bills = budget.bills.filter(bill => !removed.has(bill.id)).map(bill => {
        try {
          const name = fields.get('name-' + bill.id).trim();
          if (!name) throw new Error('Enter a vendor.');
          const day = validateDay(fields.get('day-' + bill.id), selectedMonth);
          const amountCents = toCents(fields.get('amount-' + bill.id));
          const paid = fields.has('paid-' + bill.id);
          return { ...bill, name, day, amountCents, paid, endOfMonth: day === lastDay && bill.endOfMonth };
        } catch (cause) {
          throw new Error(bill.name + ' · ' + cause.message);
        }
      });
      await commit(next => { next.bills = bills; });
    } catch (cause) {
      message.textContent = cause.message;
    }
    return;
  }
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
        const dateText = fields.get('posted-' + key).trim();
        const postedDate = dateText === displayDate(previous.postedDate) ? previous.postedDate ?? null : parseCardDate(dateText);
        const amountCents = toCents(fields.get('amount-' + key), true);
        const category = fields.get('category-' + key);
        const important = fields.get('important-' + key) === 'on';
        updates.set(key, { ...previous, vendor, postedDate, amountCents, category, important });
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
    const rows = Array.from(form.querySelectorAll('.charge-draft-item'));
    if (!rows.length) {
      message.textContent = 'Enter at least one charge.';
      return;
    }
    const dateInput = form.elements.posted.value.trim();
    let postedDate;
    try {
      postedDate = parseCardDate(dateInput.toLowerCase() === 'pending' ? '' : dateInput);
    } catch (cause) {
      message.textContent = cause.message;
      form.elements.posted.focus();
      return;
    }
    const charges = rows.map(row => ({ ...queuedCharges.get(row), id: id(), postedDate, card: activeCard }));
    await commit(next => { next.charges.push(...charges); });
    return;
  }
  if (form.id === 'add-savings') {
    const message = form.querySelector('.schedule-editor-error');
    try {
      message.textContent = '';
      const day = scheduleItemDay(fields.get('date'));
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
  if (form.id === 'add-pay') {
    const message = form.querySelector('.schedule-editor-error');
    try {
      message.textContent = '';
      const name = (fields.get('name') ?? '').trim();
      if (!name) throw new Error('Enter an income name.');
      const day = scheduleItemDay(fields.get('date'));
      const amountCents = toCents(fields.get('amount'));
      await commit(next => next.paychecks.push({ id: id(), name, day, amountCents, received: false }));
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
      }));
      const savingsTransfers = (budget.savingsTransfers ?? []).flatMap((transfer, index) => {
        if (fields.has('remove-savings-' + index)) return [];
        const day = scheduleItemDay(fields.get('savings-date-' + index));
        const cents = toCents(fields.get('savings-amount-' + index));
        if (!cents) throw new Error('Enter a savings amount greater than zero.');
        return [{ ...transfer, day, amountCents: transfer.amountCents < 0 ? -cents : cents }];
      });
      await commit(next => {
        next.openingCents = openingCents;
        next.etsyDeposits = etsyDeposits;
        next.paychecks = paychecks;
        if (next.savingsTransfers) next.savingsTransfers = savingsTransfers;
      });
    } catch (cause) {
      form.querySelector('.schedule-editor-error').textContent = cause.message;
    }
    return;
  }
  if (form.id === 'add-bill') {
    const message = form.querySelector('.schedule-editor-error');
    try {
      message.textContent = '';
      const name = (fields.get('name') ?? '').trim();
      const amountCents = toCents(fields.get('amount'));
      const debitDay = fields.get('day');
      const endOfMonth = debitDay === 'eom';
      const day = endOfMonth ? daysInMonth(selectedMonth) : validateDay(debitDay, selectedMonth);
      if (!name) throw new Error('Enter a bill name.');
      await commit(next => next.bills.push({ id: id(), name, day, amountCents, endOfMonth, paid: false }));
    } catch (cause) {
      message.textContent = cause.message;
    }
  }
});
root.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'open-bill-breakdown') {
    document.getElementById(button.getAttribute('aria-controls')).showModal();
    return;
  }
  if (action === 'open-item-dialog') {
    const dialog = document.getElementById(button.getAttribute('aria-controls'));
    for (const form of dialog.querySelectorAll('form')) {
      form.reset();
      form.querySelector('.schedule-editor-error').textContent = '';
    }
    if (dialog.id === 'schedule-item-dialog') setScheduleItemView(dialog, 'choice');
    dialog.showModal();
    return;
  }
  if (action === 'choose-schedule-item') {
    setScheduleItemView(button.closest('dialog'), button.dataset.item);
    return;
  }
  if (action === 'close-item-dialog') {
    button.closest('dialog').close();
    return;
  }
  if (action === 'open-charge-dialog') {
    root.querySelector('#charge-dialog-' + activeCard).showModal();
    return;
  }
  if (action === 'close-charge-dialog') {
    button.closest('dialog').close();
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
    updateChargeTotals(form);
    setChargeEditor(form);
    form.elements.vendor.focus();
    return;
  }
  if (action === 'select-card') return selectCard(button.dataset.card);
  if (action === 'edit-bills') {
    button.form.classList.add('is-editing');
    button.form.querySelector('.bill-fields input')?.focus();
    return;
  }
  if (action === 'cancel-bill-edits') {
    const form = button.form;
    form.reset();
    for (const row of form.querySelectorAll('li[data-bill-id][hidden]')) row.hidden = false;
    form.querySelector('.schedule-editor-error').textContent = '';
    form.classList.remove('is-editing');
    form.querySelector('[data-action="edit-bills"]').focus();
    return;
  }
  if (action === 'stage-bill-removal') {
    const row = button.closest('li');
    const next = row.nextElementSibling ?? row.previousElementSibling;
    row.hidden = true;
    const target = next?.querySelector('.bill-remove-button') ?? button.form.querySelector('[type="submit"]');
    target.focus();
    return;
  }
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
  if (action === 'toggle-savings-removal') {
    const editor = button.closest('[data-savings-editor]');
    setSavingsRemoval(editor, !editor.querySelector('input[type="checkbox"]').checked);
    return;
  }
  if (action === 'cancel-schedule') {
    const form = button.form;
    form.reset();
    for (const editor of form.querySelectorAll('[data-savings-editor]')) setSavingsRemoval(editor, false);
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
