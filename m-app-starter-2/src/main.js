import './styles.css';
import './schedule.css';
import { eventsForMonth } from './budget.js';
import { CATEGORIES, CC_CATEGORY_CODES, CARDS, cardStatementCycle, cardStatementPayments, copy, id, money, currentMonth, validMonth, daysInMonth, monthLabel, shortMonth, toCents, parsePostedDate, displayDate, validateDay, emptyPreferences, createMonth, hasLegacyPaycheckDefaults, sortedCharges, totals, compactSchedule, etsyDepositDays } from './budget.js';
import { createLocalRepository, createCloudRepository } from './repository.js';
import { supabase } from './supabase.js';
import { connectMonthNavigation, monthNavigationMarkup } from './month-navigation.js';


const root = document.getElementById('app');
const visualViewport = window.visualViewport;
let chargeFocusFrame;
function keepChargeFieldVisible() {
  if (!window.matchMedia('(max-width: 759px)').matches) return;
  cancelAnimationFrame(chargeFocusFrame);
  chargeFocusFrame = requestAnimationFrame(() => {
    const field = document.activeElement;
    if (!field?.matches('.charge-list.is-editing .charge-list-edit :is(input, select)')) return;
    const list = field.closest('.charge-list-scroll');
    const panel = field.closest('.card-panel');
    const row = field.closest('tr');
    for (const scroller of [list, panel]) {
      const bounds = scroller.getBoundingClientRect();
      const top = bounds.top + (scroller === list ? list.querySelector('thead').offsetHeight : 0);
      const rect = row.getBoundingClientRect();
      if (rect.bottom > bounds.bottom) scroller.scrollTop += rect.bottom - bounds.bottom;
      else if (rect.top < top) scroller.scrollTop += rect.top - top;
    }
  });
}
root.addEventListener('focusin', event => {
  if (event.target.matches('.charge-list.is-editing .charge-list-edit :is(input, select)')) keepChargeFieldVisible();
});
if (visualViewport) {
  const updateViewportHeight = () => {
    if (visualViewport.scale === 1 && visualViewport.height > 0) {
      root.style.setProperty('--budget-viewport-height', `${visualViewport.height}px`);
    } else {
      root.style.removeProperty('--budget-viewport-height');
    }
  };
  const updateViewportTop = () => {
    root.style.setProperty('--budget-viewport-top', `${visualViewport.scale === 1 ? visualViewport.offsetTop : 0}px`);
    keepChargeFieldVisible();
  };
  visualViewport.addEventListener('resize', updateViewportHeight);
  visualViewport.addEventListener('resize', updateViewportTop);
  visualViewport.addEventListener('scroll', updateViewportTop);
  updateViewportHeight();
  updateViewportTop();
}
const headerSizeObserver = new ResizeObserver(([{ target }]) => {
  root.style.setProperty('--budget-header-height', target.offsetHeight + 'px');
});
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let selectedMonth = currentMonth();
const scheduleSectionOverrides = new Map();
let scheduleSectionDateKey = '';
let scheduleVisibilityObserver = null;
const cardTabs = ['capone', 'amex'].map(id => CARDS.find(card => card.id === id));
let activeCard = cardTabs[0].id;
let rowTouchStart = null;
let knownVendors = [];
let budget = null, revision = 0, preferences = emptyPreferences();
let repository = null, activeUser = null, busy = false, dirty = false, error = '', notice = '', loading = true, loadToken = 0;
let hasOpenedBudget = false;
const disabled = () => busy || budget?.closed ? 'disabled' : '';
const negative = value => value < 0 ? 'negative' : '';
const amount = value => (value / 100).toFixed(2);
function accountMarkup() {
  if (!supabase) return '<div class="brand">m.</div><div class="account"><span>Stored on this device</span></div>';
  return `<button type="button" class="brand account-menu-trigger" popovertarget="account-menu" aria-label="Account options" title="Account options">m.</button>
  <div id="account-menu" popover>
    <button type="button" data-action="sign-out" ${busy || dirty ? 'disabled' : ''}>Sign out</button>
  </div>`;
}
function panelEditButton(action, label, stateClass) {
  return `<button type="button" class="panel-edit-button ${stateClass}" data-action="${action}" aria-label="${label}" title="${label}" ${disabled()}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m14.5 5.5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z"/>
    </svg>
  </button>`;
}
function panelAddMenu(menuId, label, choices) {
  return `<button type="button" class="panel-add-button" data-action="position-add-menu" aria-label="${label}" popovertarget="${menuId}" ${disabled()}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
  </button>
  <div id="${menuId}" class="panel-add-menu" popover aria-label="${label}">
    ${choices.map(([title, dialogId, view]) => `<button type="button" data-action="open-item-dialog" aria-haspopup="dialog" aria-controls="${dialogId}" data-item="${view}">${title}</button>`).join('')}
  </div>`;
}
function optionList(selected = '') {
  const placeholder = `<option value="" disabled hidden ${!selected || selected === 'Uncategorized' ? 'selected' : ''}>—</option>`;
  const options = Object.entries(CC_CATEGORY_CODES);
  if (selected && !CATEGORIES.includes(selected)) options.push(['—', selected]);
  return placeholder + options.map(([code, category]) => {
    return `<option value="${esc(category)}" ${selected === category ? 'selected' : ''}>${esc(code + ' · ' + category)}</option>`;
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
    if (typeof entry !== 'string') continue;
    let name = entry;
    while (/\([^()]*\)/.test(name)) name = name.replace(/\([^()]*\)/g, ' ');
    name = name.replace(/\s+/g, ' ').trim();
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
    <button type="button" data-action="close-item-dialog">Cancel</button>
    <button class="primary" type="submit" ${disabled()}>${label}</button>
  </div>
  <div role="alert" class="schedule-editor-error"></div>`;
  return `${panelAddMenu('schedule-add-menu', 'Add a schedule item', [
    ['Income', 'schedule-item-dialog', 'income'],
    ['Savings', 'schedule-item-dialog', 'savings'],
    ['Miscellaneous', 'bill-item-dialog', 'misc'],
  ])}
  <dialog id="schedule-item-dialog" class="schedule-item-dialog" aria-labelledby="schedule-item-title">
    <div class="schedule-item-heading">
      <h3 id="schedule-item-title" tabindex="-1">Add to schedule</h3>
      <button type="button" data-action="close-item-dialog" aria-label="Close schedule dialog">×</button>
    </div>
    <form id="add-pay" class="inline-form schedule-item-form" data-schedule-item-view="income" hidden>
      <label>Name<input name="name" required maxlength="80" placeholder="Income name"></label>
      <label>Date<input name="date" type="date" ${dateLimits} required></label>
      <label>Amount ($)<input name="amount" inputmode="decimal" placeholder="0.00" required></label>
      ${actions('Add income')}
    </form>
    <form id="add-savings" class="inline-form schedule-item-form" data-schedule-item-view="savings" hidden>
      <label>Date<input name="date" type="date" ${dateLimits} required></label>
      <label>Amount ($)<input name="amount" placeholder="+100 or -100" aria-describedby="savings-amount-hint" required></label>
      <p class="hint savings-amount-hint" id="savings-amount-hint">+ from savings · − to savings</p>
      ${actions('Add savings')}
    </form>
  </dialog>`;
}
function scheduleMarkup() {
  const monthNumber = Number(selectedMonth.slice(5));
  const lastDay = daysInMonth(selectedMonth);
  const schedule = compactSchedule(budget);
  const [month, day, year] = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).split('/');
  const dateKey = selectedMonth + '/' + year + month + day;
  if (scheduleSectionDateKey !== dateKey) {
    scheduleSectionOverrides.clear();
    scheduleSectionDateKey = dateKey;
  }
  const today = selectedMonth === year + '-' + month ? Number(day) : 0;
  const estimatedBalance = today ? eventsForMonth(budget)
    .filter(event => event.day <= today && !event.unpaidCardActivity)
    .reduce((balance, event) => balance + event.amountCents, budget.openingCents) : null;
  let sectionStart = 1;
  let sectionRows = [];
  const rowGroups = [];
  const billDialogs = [];
  let firstBillDay = 1;
  const hasBothPayTypes = ['C pay', 'A pay'].every(name => budget.paychecks.some(pay => pay.name === name));
  schedule.forEach((row, index) => {
    let label = row.label;
    if (row.kind === 'opening') label = 'BOA (x Mort/Fees)';
    if (row.kind === 'balance' && /^Checking balance$/i.test(label)) label = 'BOA Balance';
    if (row.kind === 'savings') label = 'Savings';
    label = label.replace(/(^|[\s(/·-])(\p{L})/gu, (_, prefix, letter) => prefix + letter.toUpperCase());
    const fullLabel = row.kind === 'opening' ? 'BOA after mortgage/fees' : label;
    const balanceClass = row.kind === 'opening' || row.kind === 'balance' ? 'schedule-balance' : '';
    const isRollover = row.kind === 'balance' && row.day === lastDay;
    const rowClass = isRollover ? 'schedule-ending' : balanceClass;
    const rowType = row.expenseType ?? row.kind;
    const displayCents = row.displayCents ?? row.amountCents;
    const amountClass = row.kind === 'savings' ? '' : negative(displayCents);
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
    const isNegative = displayCents < 0;
    const currency = money(Math.abs(displayCents));
    const formattedAmount = isNegative ? `(${currency})` : currency;
    const prefix = row.kind === 'savings' ? (isNegative ? '−' : '+') : (isNegative ? '(' : '');
    const suffix = isNegative && row.kind !== 'savings' ? ')' : '';
    const alignedAmount = `${prefix}${currency.slice(0, -2)}<span class="schedule-amount-cents">${currency.slice(-2)}</span><span class="schedule-amount-suffix">${suffix}</span>`;
    let displayedAmount = alignedAmount;
    if (amountName) {
      const amountLabel = row.kind === 'etsy' ? `${date} ${label}` : fullLabel;
      displayedAmount = `<span class="schedule-view-value">${displayedAmount}</span>
        <input class="schedule-edit-controls schedule-amount-input" name="${amountName}" aria-label="${esc(amountLabel)} amount in dollars" inputmode="decimal" value="${amount(row.amountCents)}" ${row.kind === 'etsy' ? '' : 'required'}>`;
    }
    if (row.expenseType === 'bill' && row.label === 'Bills' && row.day >= firstBillDay) {
      // Older versions of budget.js only provide the subtotal and its cutoff day.
      const bills = row.bills ?? budget.bills.filter(bill =>
        !bill.endOfMonth && bill.day >= firstBillDay && bill.day <= row.day
      ).sort((a, b) => a.day - b.day);
      const miscItems = row.checkingItems ?? [];
      const miscBreakdown = miscItems.length ? `<h4>MISC</h4>
        <ul class="schedule-bill-breakdown">${miscItems.map(item => `<li>
          <span>${monthNumber}/${item.day}</span>
          <span>${esc(item.name)}</span>
          <span class="numeric">${item.amountCents > 0 ? '+' : ''}${money(item.amountCents)}</span>
        </li>`).join('')}</ul>` : '';
      const totalLabel = miscItems.length ? (row.amountCents > 0 ? 'Net inflow' : row.amountCents < 0 ? 'Net outflow' : 'Net total') : 'Total';
      firstBillDay = row.day + 1;
      const dialogId = 'schedule-bills-' + index;
      displayedAmount = `<button type="button" class="schedule-bill-trigger" data-action="open-bill-breakdown"
        aria-haspopup="dialog" aria-controls="${dialogId}" aria-label="View bills through ${date}, subtotal ${formattedAmount}">${alignedAmount}</button>`;
      billDialogs.push(`<dialog id="${dialogId}" class="schedule-item-dialog" aria-labelledby="${dialogId}-title">
        <div class="schedule-item-heading">
          <h3 id="${dialogId}-title">Bills through ${date}</h3>
          <button type="button" data-action="close-item-dialog" aria-label="Close bill details">×</button>
        </div>
        ${miscItems.length ? '<h4>Bills</h4>' : ''}
        ${bills.length ? `<ul class="schedule-bill-breakdown">${bills.map(bill => `<li>
          <span>${monthNumber}/${bill.day}</span>
          <span>${esc(bill.name)}</span>
          <span class="numeric">${money(bill.amountCents)}</span>
        </li>`).join('')}</ul>` : '<p class="hint">No bills in this group.</p>'}
        ${miscBreakdown}
        <p class="numeric"><strong>${totalLabel} ${money(Math.abs(row.amountCents))}</strong></p>
      </dialog>`);
    }
    const sectionId = 'schedule-section-' + row.day;
    const checkpoint = row.kind === 'balance' && row.day !== lastDay && sectionRows.length > 0;
    const expanded = scheduleSectionOverrides.get(sectionId) ?? (today >= sectionStart && today <= row.day);
    const description = isRollover
      ? 'BOA Rollover'
      : `<span class="schedule-description" title="${esc(fullLabel)}">${esc(label)}</span>`;
    const rowMarkup = `<tr class="${rowClass} schedule-type-${rowType}${checkpoint ? ' schedule-checkpoint' : ''}">
      <td class="schedule-date">${date}</td>
      <th scope="row">${checkpoint ? `
        <button type="button" class="schedule-section-toggle" data-action="toggle-schedule-section"
          aria-controls="${sectionId}" aria-expanded="${expanded}"
          aria-label="${esc(label)}, ${date}, ${esc(formattedAmount)}">${description}<span class="schedule-section-chevron" aria-hidden="true"></span></button>
        <span class="schedule-edit-controls">${esc(label)}</span>` : description}</th>
      <td class="numeric ${amountClass}">${displayedAmount}</td>
    </tr>`;
    if (row.kind === 'opening') {
      rowGroups.push(`<tbody>${rowMarkup}</tbody>`);
    } else if (row.kind === 'balance') {
      if (checkpoint) {
        rowGroups.push(`<tbody id="${sectionId}" class="schedule-section" ${expanded ? '' : 'data-collapsed'}>${sectionRows.join('')}</tbody>`);
      } else if (sectionRows.length) {
        rowGroups.push(`<tbody>${sectionRows.join('')}</tbody>`);
      }
      rowGroups.push(`<tbody>${rowMarkup}</tbody>`);
      sectionRows = [];
      sectionStart = row.day + 1;
    } else {
      sectionRows.push(rowMarkup);
    }
  });
  if (sectionRows.length) rowGroups.push(`<tbody>${sectionRows.join('')}</tbody>`);
  const cardStatements = cardStatementPayments(budget);
  const paidCards = cardTabs.map(tab => cardStatements.find(card => card.id === tab.id))
    .filter(card => card.paidCents > 0);
  const cardPaymentChecks = paidCards.map(card => {
    const chargeTotal = card.paidCents + card.netCents;
    let summary = `${money(card.paidCents)} paid in full`;
    if (card.netCents > 0) {
      summary = `${money(card.paidCents)} of ${money(chargeTotal)} paid · ${money(card.netCents)} remaining`;
    } else if (card.netCents < 0) {
      summary = `${money(card.paidCents)} paid · ${money(-card.netCents)} credit balance`;
    }
    return `<p class="schedule-card-check">${card.netCents === 0 ? '✓ ' : ''}${card.name} · ${summary}</p>`;
  }).join('');
  const lastDate = `${selectedMonth}-${lastDay}`;
  const savingsEditors = (budget.savingsTransfers ?? []).map((transfer, index) => {
    const date = `${selectedMonth}-${String(transfer.day).padStart(2, '0')}`;
    return `<div class="schedule-savings-transfer" data-savings-editor>
      <div class="schedule-savings-heading">
        <strong>Savings</strong>
        <button type="button" data-action="toggle-savings-removal">Remove</button>
        <input type="checkbox" name="remove-savings-${index}" hidden>
      </div>
      <fieldset class="schedule-savings-fields" aria-label="Savings details">
        <label>Date<input name="savings-date-${index}" type="date" min="${selectedMonth}-01" max="${lastDate}" value="${date}" required></label>
        <label>Amount ($)<input name="savings-amount-${index}" value="${transfer.amountCents > 0 ? '+' : ''}${amount(transfer.amountCents)}" aria-describedby="edit-savings-amount-hint" required></label>
      </fieldset>
    </div>`;
  }).join('');

  return `<section class="panel schedule-panel">
    <form id="edit-schedule">
    <div class="panel-heading">
      <h2>Monthly schedule</h2>
      ${estimatedBalance === null ? '' : `<p class="hint schedule-balance-estimate">Est. BOA balance today (${Number(month)}/${today}) · <strong>${money(estimatedBalance)}</strong></p>`}
      ${budget.closed ? `<button type="button" data-action="reopen-month" ${busy || dirty ? 'disabled' : ''}>Reopen month</button>` : `${panelEditButton('edit-schedule', 'Edit monthly schedule', 'schedule-view-value')}
      <div class="schedule-edit-controls schedule-editor-actions">
        ${hasBothPayTypes ? '' : '<button type="button" data-action="load-paycheck-template">Use C/A template</button>'}
        <button type="button" data-action="cancel-schedule">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>`}
    </div>
    <div role="alert" class="schedule-edit-controls schedule-editor-error"></div>
    <div class="tile-scroll" role="region" aria-label="Schedule entries" tabindex="0">
    <table class="schedule schedule-ledger" aria-label="Monthly schedule">
      <thead>
        <tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col" class="numeric">Amount</th></tr>
      </thead>
      ${rowGroups.join('')}
    </table>
    ${cardPaymentChecks ? `<div role="group" aria-label="Card payment checks">${cardPaymentChecks}</div>` : ''}
    ${savingsEditors ? `<section class="schedule-edit-controls schedule-savings-editor" aria-label="Edit savings">
      <h3>Savings</h3>
      <p class="hint savings-amount-hint" id="edit-savings-amount-hint">+ from savings · − to savings</p>
      ${savingsEditors}
    </section>` : ''}
    </div>
    </form>
    ${billDialogs.join('')}
    ${scheduleItemDialogMarkup(lastDay)}
  </section>`;
}
function cardChargeTable(charges, scope, fullActivity = false) {
  const paymentEntries = (budget.cardPayments ?? []).filter(payment => payment.card === scope).map(payment => ({
    id: payment.id,
    postedDate: `${selectedMonth}-${String(payment.day).padStart(2, '0')}`,
    amountCents: -payment.amountCents,
    isPayment: true,
  }));
  if (!charges.length && !paymentEntries.length) return '<p class="hint">No card activity entered for this month.</p>';
  const editable = !fullActivity && !budget.closed && charges.length > 0;
  const rows = sortedCharges([...charges, ...paymentEntries]).reverse().map((charge, index, orderedCharges) => {
    const date = displayDate(charge.postedDate);
    const dateChanged = index > 0 && (charge.postedDate ?? '') !== (orderedCharges[index - 1].postedDate ?? '');
    if (charge.isPayment) {
      return `<tr data-payment-id="${esc(charge.id)}" class="charge-payment-row${dateChanged ? ' charge-date-divider' : ''}">
        ${editable ? '<td class="charge-list-edit charge-important-cell"></td>' : ''}
        <td><span class="charge-list-view">—</span></td>
        <td class="charge-vendor-cell">${budget.closed ? '<span class="charge-list-view">Payment</span>' :
          `<button type="button" class="charge-list-view charge-vendor-button" data-action="edit-card-payment" aria-haspopup="dialog" ${disabled()}>Payment</button>`}</td>
        <td class="numeric"><span class="charge-list-view">${money(charge.amountCents)}</span></td>
        <td class="charge-date-cell"><span class="charge-list-view">${esc(date)}</span>
          ${budget.closed ? '' : `<button type="button" class="charge-swipe-delete" data-swipe-delete data-action="confirm-row-removal"
            aria-label="Delete payment on ${esc(date)}" aria-haspopup="dialog" hidden ${disabled()}>Delete</button>`}
        </td>
      </tr>`;
    }
    const key = esc(charge.id);
    const vendor = esc(charge.vendor);
    const code = Object.entries(CC_CATEGORY_CODES).find(([, category]) => category === charge.category)?.[0] ?? '—';
    const rowClass = [
      dateChanged ? 'charge-date-divider' : '',
      charge.important === true ? 'charge-important' : '',
      charge.amountCents < 0 ? 'charge-refund' : '',
    ].filter(Boolean).join(' ');
    const edit = editable ? [
      `<select class="charge-code-edit" name="category-${key}" data-category-code aria-label="Category code for ${vendor}">${optionList(charge.category)}</select>`,
      `<input name="vendor-${key}" value="${vendor}" list="card-vendor-history" maxlength="160" aria-label="Vendor for ${vendor}">`,
      `<input name="posted-${key}" value="${esc(date)}" placeholder="MMDD" inputmode="numeric" maxlength="10" aria-label="Date for ${vendor} (MMDD, blank for pending)">`,
      `<input name="amount-${key}" value="${amount(charge.amountCents)}" inputmode="text" aria-label="Amount for ${vendor}">`,
    ] : [];
    const cell = (value, index) => `<span class="charge-list-view">${value}</span>${edit[index] ? `<div class="charge-list-edit">${edit[index]}</div>` : ''}`;
    const vendorCell = fullActivity ? cell(vendor, 1) : `
      <button type="button" class="charge-list-view charge-vendor-button" data-action="show-charge-vendor"
        aria-label="Show full vendor name: ${vendor}" popovertarget="charge-vendor-details">${vendor}</button>
      ${edit[1] ? `<div class="charge-list-edit">${edit[1]}</div>` : ''}`;
    return `<tr data-charge-id="${key}" data-charge-code="${code}" class="${rowClass}">
      ${editable ? `<td class="charge-list-edit charge-important-cell">
        <label class="charge-important-toggle" title="Important"><input type="checkbox" name="important-${key}" aria-label="Mark ${vendor} important" ${charge.important === true ? 'checked' : ''}><span aria-hidden="true">★</span></label>
      </td>` : ''}
      <td><span class="charge-list-view" title="${esc(charge.category)}">${code}</span>${edit[0] ? `<div class="charge-list-edit">${edit[0]}</div>` : ''}</td>
      <td class="charge-vendor-cell">${vendorCell}</td>
      <td class="numeric">${cell(esc(money(charge.amountCents)), 3)}</td>
      <td class="charge-date-cell">${cell(esc(date || 'Pending'), 2)}
        ${editable ? `<button type="button" class="charge-swipe-delete" data-swipe-delete data-action="confirm-row-removal"
          aria-label="Delete ${vendor}" aria-haspopup="dialog" hidden ${disabled()}>Delete</button>` : ''}
      </td>
    </tr>`;
  }).join('');
  const table = `<table class="charge-list-table">
    <thead><tr>${editable ? '<th scope="col" class="charge-list-edit charge-important-cell" aria-label="Important">★</th>' : ''}<th scope="col">Code</th><th scope="col" class="charge-vendor-cell">Vendor</th><th scope="col" class="numeric">Amt</th><th scope="col">Date</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  if (fullActivity) return table;
  return `<form class="charge-list" data-charge-scope="${scope}">
    ${editable ? (scope ? panelEditButton('edit-charges', 'Edit card charges', 'charge-list-view') : `<button class="charge-list-view" type="button" data-action="edit-charges" ${disabled()}>Edit charges</button>`) : ''}
    <div class="charge-list-scroll" role="region" aria-label="Saved charges" tabindex="0">${table}</div>
    <div role="alert" class="schedule-editor-error"></div>
    ${editable ? `<div class="charge-list-actions charge-list-edit">
      <button type="button" data-action="cancel-charge-edits" ${disabled()}>Cancel</button>
      <button class="primary" type="submit" ${disabled()}>Save changes</button>
    </div>` : ''}
  </form>`;
}
function cardCycleDates(card) {
  const cycle = cardStatementCycle(selectedMonth, card.dueDay);
  return displayDate(cycle.from) + ' to ' + displayDate(cycle.until);
}
function cardExpenseSummary(charges) {
  if (!charges.length) return '<p class="hint">No charges recorded for this card.</p>';
  const totalsByCategory = new Map();
  const codesByCategory = new Map(Object.entries(CC_CATEGORY_CODES).map(([code, category]) => [category, code]));
  let total = 0;
  for (const charge of charges) {
    const category = charge.category || 'Uncategorized';
    totalsByCategory.set(category, (totalsByCategory.get(category) ?? 0) + charge.amountCents);
    total += charge.amountCents;
  }
  const rows = [...totalsByCategory].map(([category, cents]) => ({ category, cents, code: codesByCategory.get(category) }))
    .sort((a, b) => b.cents - a.cents || (a.code ?? 'ZZ').localeCompare(b.code ?? 'ZZ') || a.category.localeCompare(b.category));
  return `<table class="card-expense-summary" aria-label="Expenses by code">
    <thead><tr><th scope="col">Code</th><th scope="col">Category</th><th scope="col">Total</th></tr></thead>
    <tbody>${rows.map(({ category, cents, code }) => `<tr><td>${code ?? '—'}</td><th scope="row">${esc(category)}</th><td>${money(cents)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th scope="row" colspan="2">Total expenses</th><td>${money(total)}</td></tr></tfoot>
  </table>`;
}
function cardMarkup() {
  const payments = cardStatementPayments(budget);
  const unassigned = budget.charges.filter(charge => !charge.card);
  const draftEditor = cardId => `<div class="charge-draft-editor">
    <div class="charge-draft-primary">
      <label>Vendor<input name="vendor" list="card-vendor-history" autocomplete="off" maxlength="160" ${disabled()}></label>
      <div class="charge-draft-amount">
        <label for="charge-draft-amount-${cardId}">Amount ($)</label>
        <div class="charge-amount-control">
          <input id="charge-draft-amount-${cardId}" name="amount" inputmode="decimal" placeholder="0.00" ${disabled()}>
          <button type="button" data-action="flip-charge-sign" aria-label="Refund amount" aria-pressed="false" ${disabled()}>±</button>
        </div>
      </div>
    </div>
    <label class="charge-draft-date">Posted date<input name="posted" aria-label="Posted date (optional, MMDD)" placeholder="Pending" inputmode="numeric" maxlength="10" autocomplete="off" ${disabled()}></label>
    <label>Code
      <select name="category" ${disabled()}>${optionList()}</select>
    </label>
    <div class="charge-draft-flag">
      <span>Flag</span>
      <label class="charge-important-toggle">
        <input type="checkbox" name="important" aria-label="Important" ${disabled()}><span aria-hidden="true">★</span>
      </label>
    </div>
    <div class="charge-draft-actions">
      <button type="button" data-action="remove-charge-draft" hidden>Remove charge</button>
      <button type="button" data-action="queue-charge" ${disabled()}>+ Add next</button>
    </div>
  </div>`;
  const tabs = cardTabs.map(card => {
    const selected = card.id === activeCard;
    return `<button type="button" role="tab" id="card-tab-${card.id}"
      aria-selected="${selected}" aria-controls="card-panel-${card.id}" tabindex="${selected ? 0 : -1}"
      data-action="select-card" data-card="${card.id}">${card.name}</button>`;
  }).join('');
  const panels = cardTabs.map(card => {
    const charges = budget.charges.filter(charge => charge.card === card.id);
    const posted = charges.reduce((sum, charge) => sum + (charge.postedDate ? charge.amountCents : 0), 0);
    const pending = charges.reduce((sum, charge) => sum + (charge.postedDate ? 0 : charge.amountCents), 0);
    const payment = payments.find(item => item.id === card.id);
    const recordedPayments = (budget.cardPayments ?? []).filter(entry => entry.card === card.id).sort((a, b) => b.day - a.day);
    const canRecordPayment = !budget.closed && payment.amountCents > 0;
    const dueDate = selectedMonth + '-' + String(card.dueDay).padStart(2, '0');
    const defaultPaymentDate = currentMonth() === selectedMonth
      ? selectedMonth + '-' + new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', day: '2-digit' }).format(new Date())
      : dueDate;
    return `<div class="card-tab-panel" id="card-panel-${card.id}" role="tabpanel"
      aria-labelledby="card-tab-${card.id}" data-card-panel="${card.id}" ${card.id === activeCard ? '' : 'hidden'}>
      <div class="card-cycle">
        <p class="hint">${card.name} statement cycle · ${cardCycleDates(card)}</p>
        <p class="hint">${money(payment.amountCents)} due <time datetime="${dueDate}">${shortMonth(selectedMonth)} ${card.dueDay}</time></p>
      </div>
      <div class="card-totals${recordedPayments.length ? ' card-totals-with-payment' : ''}">
        <div>Posted<strong>${money(posted)}</strong></div>
        <div>Pending<strong>${money(pending)}</strong></div>
        ${recordedPayments.length ? `<div class="card-total-paid">Paid<strong>${money(payment.paidCents)}</strong></div>
        <div>Net total<strong>${money(payment.netCents)}</strong></div>` : `<div>Total<strong>${money(posted + pending)}</strong></div>`}
      </div>
      ${cardChargeTable(charges, card.id)}
      ${canRecordPayment || recordedPayments.length ? `<dialog id="card-payments-${card.id}" class="schedule-item-dialog" aria-labelledby="card-payments-title-${card.id}">
        <div class="schedule-item-heading charge-entry-heading">
          <div>
            <div class="hint">${card.name}</div>
            <h3 id="card-payments-title-${card.id}">${canRecordPayment ? 'Record payment' : 'Payment history'}</h3>
            <p class="hint">${money(payment.paidCents)} recorded · ${money(payment.amountCents)} remaining</p>
          </div>
          <button type="button" data-action="close-item-dialog" aria-label="Close payments">×</button>
        </div>
        ${recordedPayments.length ? `<ul class="card-payment-history" aria-label="Recorded payments">${recordedPayments.map(entry => `<li data-payment-id="${esc(entry.id)}">
          <span>${Number(selectedMonth.slice(5))}/${entry.day}</span><strong>${money(entry.amountCents)}</strong>
          ${budget.closed ? '' : `<button type="button" data-action="edit-card-payment" aria-haspopup="dialog" ${disabled()}>Edit</button>
          <button type="button" data-action="confirm-row-removal" aria-haspopup="dialog" ${disabled()}>Remove</button>`}
        </li>`).join('')}</ul>` : ''}
        ${canRecordPayment ? `<form class="card-payment-form" data-card-payment="${card.id}">
          <label>Payment type<select name="paymentType" ${disabled()}><option value="full">Full balance</option><option value="partial">Partial payment</option></select></label>
          <label class="card-payment-amount">Amount ($)<input name="amount" inputmode="decimal" ${disabled()}></label>
          <label>Payment date<input name="date" type="date" min="${selectedMonth}-01" max="${selectedMonth}-${daysInMonth(selectedMonth)}" value="${defaultPaymentDate}" required ${disabled()}></label>
          <div role="alert" class="schedule-editor-error"></div>
          <button type="submit" class="primary" ${disabled()}>Record payment</button>
        </form>` : ''}
      </dialog>` : ''}
      ${budget.closed ? '' : `<dialog id="charge-dialog-${card.id}" class="charge-dialog charge-entry-dialog" aria-labelledby="charge-dialog-title-${card.id}">
        <div class="schedule-item-heading charge-entry-heading">
          <div><div class="hint">${card.name}</div><h3 id="charge-dialog-title-${card.id}">Add charges</h3></div>
          <button type="button" data-action="close-charge-dialog" aria-label="Close add charges">×</button>
        </div>
        <form id="add-charges-${card.id}" class="charge-batch-form">
          ${draftEditor(card.id)}
          <div class="charge-draft-list" role="group" aria-label="Charges in this batch"></div>
          <div class="charge-batch-actions">
            <div role="alert" class="schedule-editor-error"></div>
            <button type="submit" class="primary" disabled>Save charges</button>
          </div>
        </form>
      </dialog>`}
    </div>`;
  }).join('');
  return `<section class="panel card-panel">
    <div class="panel-heading card-panel-heading"><h2>CREDIT CARD ACTIVITY</h2></div>
    <button type="button" class="card-month-activity-button" data-action="open-card-month-activity"
      aria-label="View full monthly activity for the selected card" aria-haspopup="dialog" aria-controls="card-month-activity">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>
      </svg>
    </button>
    <button type="button" class="card-month-activity-button card-expense-summary-button" data-action="open-card-expense-summary"
      aria-label="View expenses by code for the selected card" aria-haspopup="dialog" aria-controls="card-month-activity">
      <span class="card-expense-summary-icon" aria-hidden="true"><span></span><span></span><span></span></span>
    </button>
    <div class="card-tabs" role="tablist" aria-label="Credit cards">${tabs}</div>
    ${panels}
    <dialog id="card-month-activity" class="charge-dialog card-month-activity" aria-labelledby="card-month-activity-title">
      <div class="schedule-item-heading card-month-activity-heading">
        <div class="card-month-activity-labels">
          <h3 id="card-month-activity-title"></h3>
          <p class="hint card-month-activity-cycle" data-activity-cycle></p>
        </div>
        <button type="button" data-action="close-charge-dialog" aria-label="Close card details">×</button>
      </div>
      <div class="card-month-activity-list" role="region" aria-label="Full credit card transactions" tabindex="0"></div>
    </dialog>
    <div id="charge-vendor-details" class="charge-vendor-popover" popover="auto"></div>
    ${budget.closed ? '' : `<dialog id="edit-card-payment-dialog" class="schedule-item-dialog" aria-labelledby="edit-card-payment-title">
      <div class="schedule-item-heading charge-entry-heading">
        <div><div class="hint" data-payment-card-name></div><h3 id="edit-card-payment-title">Edit payment</h3></div>
        <button type="button" data-action="close-item-dialog" aria-label="Close edit payment">×</button>
      </div>
      <form id="edit-card-payment" class="card-payment-form">
        <label>Amount ($)<input name="amount" inputmode="decimal" required ${disabled()}></label>
        <label>Payment date<input name="date" type="date" min="${selectedMonth}-01" max="${selectedMonth}-${daysInMonth(selectedMonth)}" required ${disabled()}></label>
        <div role="alert" class="schedule-editor-error"></div>
        <button type="submit" class="primary" ${disabled()}>Save payment</button>
      </form>
    </dialog>`}
    <dialog id="entry-delete-dialog" class="charge-dialog" aria-labelledby="entry-delete-title" aria-describedby="entry-delete-details">
      <h3 id="entry-delete-title">Remove this entry?</h3>
      <p id="entry-delete-details" class="charge-vendor-name"></p>
      <div class="charge-delete-actions">
        <button type="button" data-action="close-charge-dialog" autofocus>Cancel</button>
        <button type="button" data-action="delete-confirmed-row">Remove</button>
      </div>
    </dialog>
    <datalist id="card-vendor-history">${knownVendors.map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>
    ${unassigned.length ? `<details class="statement"><summary>Unassigned charges (${unassigned.length})</summary>${cardChargeTable(unassigned, '')}</details>` : ''}
    ${budget.closed ? '' : `<button type="button" class="primary charge-add-button" data-action="open-charge-dialog" aria-haspopup="dialog" ${disabled()}>+ Add charges</button>`}
    ${payments.map(card => {
      const canRecordPayment = !budget.closed && card.amountCents > 0;
      if (!canRecordPayment && !card.paidCents) return '';
      return `<button type="button" class="card-payment-button" data-action="open-card-payments"
        data-payment-card="${card.id}" aria-haspopup="dialog" aria-controls="card-payments-${card.id}"
        ${card.id === activeCard ? '' : 'hidden'} ${busy ? 'disabled' : ''}>${canRecordPayment ? 'Record payment' : 'Payments'}</button>`;
    }).join('')}
  </section>`;
}
function billsMarkup() {
  const lastDay = daysInMonth(selectedMonth);
  const debitDayOptions = (selected = '1') => Array.from({ length: lastDay }, (_, index) => {
    const day = index + 1;
    return `<option value="${day}" ${selected === String(day) ? 'selected' : ''}>${day}</option>`;
  }).join('') + `<option value="eom" ${selected === 'eom' ? 'selected' : ''}>EOM</option>`;
  const bills = budget.bills.slice().sort((a, b) => a.day - b.day);
  const subtotal = bills.reduce((total, bill) => total + bill.amountCents, 0);
  const debitDate = bill => `${Number(selectedMonth.slice(5))}/${bill.day}`;
  const rowName = name => budget.closed ? `<span class="bill-summary-name" title="${name}">${name}</span>` :
    `<button type="button" class="bill-summary-name checking-row-toggle" data-action="toggle-checking-removal"
      title="${name}" aria-label="Removal options for ${name}" aria-expanded="false" ${disabled()}>${name}</button>`;
  const removeButton = name => budget.closed ? '' : `<button type="button" class="charge-swipe-delete checking-item-delete" data-swipe-delete
    data-action="confirm-row-removal" aria-label="Remove ${name}" aria-haspopup="dialog" ${disabled()} hidden>Remove</button>`;
  const rows = bills.map(bill => {
    const key = esc(bill.id);
    const name = esc(bill.name);
    return `<li data-bill-id="${key}">
      <div class="bill-summary">
        <span class="bill-summary-date">${bill.endOfMonth ? '<abbr title="End of month">EOM</abbr>' : debitDate(bill)}</span>
        ${rowName(name)}
        <span class="bill-summary-amount">${money(bill.amountCents)}</span>
        <label class="bill-paid-field"><input type="checkbox" id="bill-paid-${key}" data-kind="bill-paid" data-id="${key}" aria-label="Mark ${name} paid" ${bill.paid ? 'checked' : ''} ${disabled()}></label>
      </div>
      ${removeButton(name)}
      ${budget.closed ? '' : `<div class="bill-fields">
        <select name="day-${key}" aria-label="Debit day for ${name}" ${disabled()}>${debitDayOptions(bill.endOfMonth ? 'eom' : String(bill.day))}</select>
        <input name="name-${key}" value="${name}" maxlength="100" aria-label="Vendor for ${name}" ${disabled()}>
        <input name="amount-${key}" inputmode="decimal" value="${amount(bill.amountCents)}" aria-label="Amount for ${name}" ${disabled()}>
        <label class="bill-paid-field"><input type="checkbox" name="paid-${key}" aria-label="Mark ${name} paid" ${bill.paid ? 'checked' : ''} ${disabled()}></label>
      </div>`}
    </li>`;
  }).join('');
  const checkingRows = (budget.checkingItems ?? []).slice().sort((a, b) => a.day - b.day).map(item => {
    const key = esc(item.id);
    const name = esc(item.name);
    return `<li data-checking-id="${key}">
      <div class="bill-summary checking-item-summary">
        <span class="bill-summary-date">${debitDate(item)}</span>
        ${rowName(name)}
        <span class="bill-summary-amount">${item.amountCents > 0 ? '+' : ''}${money(item.amountCents)}</span>
      </div>
      ${removeButton(name)}
      ${budget.closed ? '' : `<div class="bill-fields checking-item-fields">
        <input type="number" name="misc-day-${key}" min="1" max="${lastDay}" value="${item.day}" aria-label="Day for ${name}" ${disabled()}>
        <input name="misc-name-${key}" value="${name}" maxlength="100" aria-label="Description for ${name}" ${disabled()}>
        <input name="misc-amount-${key}" value="${amount(item.amountCents)}" aria-label="Signed amount for ${name}" ${disabled()}>
      </div>`}
    </li>`;
  }).join('');
  const canEdit = !budget.closed && (rows || checkingRows);
  return `<section class="panel bills-panel">
    <form id="edit-bills" novalidate>
      <div class="panel-heading">
        <div><h2>Bills</h2><p class="hint">${bills.filter(bill => bill.paid).length} of ${bills.length} paid · ${money(subtotal)} total · ${money(totals(budget).remainingBills)} still to clear</p></div>
        ${canEdit ? panelEditButton('edit-bills', 'Edit checking bills', 'bill-edit-button') : ''}
      </div>
      <div class="tile-scroll" role="region" aria-label="Checking entries" tabindex="0">
      ${rows ? `<ul class="bill-list">${rows}</ul>` : '<p class="hint">No bills for this month.</p>'}
      ${checkingRows ? `<section class="checking-items" aria-label="Misc checking">
        <h3>MISC</h3>
        <ul class="bill-list">${checkingRows}</ul>
      </section>` : ''}
      </div>
      <div role="alert" class="schedule-editor-error"></div>
      ${canEdit ? `<div class="bill-edit-actions">
        <button type="button" data-action="cancel-bill-edits" ${disabled()}>Cancel</button>
        <button type="submit" class="primary" ${disabled()}>Save changes</button>
      </div>` : ''}
    </form>
    ${budget.closed ? '' : `${panelAddMenu('bills-add-menu', 'Add a checking entry', [
      ['Bill', 'bill-item-dialog', 'bill'],
      ['Miscellaneous', 'bill-item-dialog', 'misc'],
    ])}
    <dialog id="bill-item-dialog" class="schedule-item-dialog" aria-labelledby="bill-item-title">
      <div class="schedule-item-heading">
        <h3 id="bill-item-title">Add to checking</h3>
        <button type="button" data-action="close-item-dialog" aria-label="Close bill dialog">×</button>
      </div>
      <form id="add-bill" class="inline-form schedule-item-form" data-schedule-item-view="bill" hidden>
        <label>Bill name<input name="name" maxlength="100" placeholder="Mortgage, water…" required ${disabled()}></label>
        <label>Debit day<select name="day" ${disabled()}>${debitDayOptions()}</select></label>
        <label>Amount ($)<input name="amount" inputmode="decimal" placeholder="0.00" required ${disabled()}></label>
        <div class="schedule-item-actions">
          <button type="button" data-action="close-item-dialog">Cancel</button>
          <button class="primary" type="submit" ${disabled()}>Add bill</button>
        </div>
        <div role="alert" class="schedule-editor-error"></div>
      </form>
      <form id="add-checking-item" class="inline-form schedule-item-form" data-schedule-item-view="misc" hidden>
        <label>Description<input name="name" maxlength="100" placeholder="Venmo, reimbursement…" required ${disabled()}></label>
        <label>Date<input name="date" type="date" min="${selectedMonth}-01" max="${selectedMonth}-${lastDay}" required ${disabled()}></label>
        <label>Amount ($)<input name="amount" placeholder="+100 or -100" aria-describedby="checking-amount-hint" required ${disabled()}></label>
        <p class="hint savings-amount-hint" id="checking-amount-hint">+ money in · − money out</p>
        <div class="schedule-item-actions">
          <button type="button" data-action="close-item-dialog">Cancel</button>
          <button class="primary" type="submit" ${disabled()}>Add item</button>
        </div>
        <div role="alert" class="schedule-editor-error"></div>
      </form>
    </dialog>`}
  </section>`;
}
function chargeScrollPosition(list) {
  const bounds = list.getBoundingClientRect();
  const headerHeight = list.querySelector('thead')?.offsetHeight ?? 0;
  const row = Array.from(list.querySelectorAll('[data-charge-id]')).find(row => {
    const rect = row.getBoundingClientRect();
    return rect.bottom > bounds.top + headerHeight && rect.top < bounds.bottom;
  });
  return { top: list.scrollTop, id: row?.dataset.chargeId, offset: row ? row.getBoundingClientRect().top - bounds.top : 0 };
}

function restoreChargeScroll(list, position) {
  const row = position.id && list.querySelector(`[data-charge-id="${CSS.escape(position.id)}"]`);
  list.scrollTop = row
    ? list.scrollTop + row.getBoundingClientRect().top - list.getBoundingClientRect().top - position.offset
    : position.top;
}

function showOpeningScreen() {
  if (root.querySelector('.opening-screen')) return;
  root.innerHTML = '<div class="opening-screen" role="status" aria-label="Loading budget"><div class="opening-backdrop" aria-hidden="true"></div><span aria-hidden="true">m.</span></div>';
}

function finishOpeningScreen(screen) {
  const brand = root.querySelector('.topline .brand');
  if (!screen || !brand || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.append(screen);
  const logo = screen.lastElementChild;
  const logoOpacity = getComputedStyle(logo).opacity;
  screen.classList.add('is-leaving');
  const brandStyle = getComputedStyle(brand);
  logo.style.fontFamily = brandStyle.fontFamily;
  logo.style.fontWeight = brandStyle.fontWeight;
  logo.style.letterSpacing = brandStyle.letterSpacing;
  const from = logo.getBoundingClientRect();
  const to = brand.getBoundingClientRect();
  const x = to.left + to.width / 2 - from.left - from.width / 2;
  const y = to.top + to.height / 2 - from.top - from.height / 2;
  logo.style.left = `${x}px`;
  const scale = parseFloat(brandStyle.fontSize) / parseFloat(getComputedStyle(logo).fontSize);
  const timing = { duration: 1100, easing: 'ease-in-out', fill: 'forwards' };
  brand.classList.add('opening-brand');
  screen.querySelector('.opening-backdrop').animate([
    { opacity: 1 },
    { opacity: 1, offset: 0.15 },
    { opacity: 0 },
  ], timing);
  const transition = logo.animate([
    { transform: 'none', color: '#f6fbf7', opacity: logoOpacity },
    { transform: `translateY(${y}px) scale(${scale})`, color: brandStyle.color, opacity: 1 },
  ], timing);
  const finish = () => {
    screen.remove();
    brand.classList.remove('opening-brand');
  };
  transition.finished.then(finish, finish);
}

function render() {
  headerSizeObserver.disconnect();
  scheduleVisibilityObserver?.disconnect();
  if (supabase && !activeUser) return renderAuth();
  if (!budget) {
    if (loading && !hasOpenedBudget) showOpeningScreen();
    else if (loading) root.innerHTML = '<main class="auth" role="status" aria-label="Loading budget"><div class="wordmark" aria-hidden="true">m.</div></main>';
    else root.innerHTML = `<main class="auth"><div class="wordmark">m.</div><p>${esc(error || 'Could not open your budget.')}</p><button data-action="reload">Try again</button></main>`;
    return;
  }
  const openingScreen = hasOpenedBudget ? null : root.querySelector('.opening-screen');
  hasOpenedBudget = true;
  const tileScrollSelector = '.workspace .tile-scroll';
  const enteringSchedule = !root.querySelector('.schedule-panel');
  const tileScroll = root.querySelector('.workspace')?.scrollLeft ?? 0;
  const tileScrollTops = Array.from(root.querySelectorAll(tileScrollSelector), list => list.scrollTop);
  const chargePositions = new Map();
  for (const form of root.querySelectorAll('.charge-list[data-charge-scope]')) {
    const list = form.querySelector('.charge-list-scroll');
    if (list?.clientHeight) chargePositions.set(form.dataset.chargeScope, chargeScrollPosition(list));
  }
  root.innerHTML = `<div class="app-shell"><header><div class="topline">${accountMarkup()}</div>${monthNavigationMarkup(selectedMonth, busy || dirty)}<div class="save-line" role="status">${busy ? 'Saving…' : dirty ? 'Changes need to be saved' : supabase ? 'Saved to your account' : 'Saved on this device'}${notice ? ` · ${esc(notice)}` : ''}</div></header>${error ? `<div class="error-banner" role="alert"><p>${esc(error)}</p><div>${dirty ? '<button data-action="retry">Retry save</button>' : ''}<button data-action="reload">Reload saved version</button></div></div>` : ''}<main class="workspace">${scheduleMarkup()}<div class="ledgers">${cardMarkup()}${billsMarkup()}</div></main></div>`;
  const header = root.querySelector('.app-shell > header');
  root.style.setProperty('--budget-header-height', header.offsetHeight + 'px');
  headerSizeObserver.observe(header);
  root.querySelector('.workspace').scrollLeft = tileScroll;
  root.querySelectorAll(tileScrollSelector).forEach((list, index) => { list.scrollTop = tileScrollTops[index] ?? 0; });
  const workspace = root.querySelector('.workspace');
  const schedulePanel = workspace.querySelector('.schedule-panel');
  const scheduleList = schedulePanel.querySelector('.tile-scroll');
  const showRollover = () => {
    if (schedulePanel.isConnected && !schedulePanel.querySelector('.is-editing')) {
      scheduleList.scrollTop = scheduleList.scrollHeight;
    }
  };
  if (enteringSchedule) requestAnimationFrame(showRollover);
  let scheduleVisible = workspace.scrollLeft < workspace.clientWidth / 2;
  scheduleVisibilityObserver = new IntersectionObserver(([entry]) => {
    const visible = entry.isIntersecting && entry.intersectionRatio >= 0.6;
    if (visible && !scheduleVisible && workspace.scrollWidth > workspace.clientWidth) showRollover();
    scheduleVisible = visible;
  }, { root: workspace, threshold: [0, 0.6] });
  scheduleVisibilityObserver.observe(schedulePanel);
  for (const form of root.querySelectorAll('.charge-list[data-charge-scope]')) {
    const list = form.querySelector('.charge-list-scroll');
    const position = chargePositions.get(form.dataset.chargeScope);
    if (list && position) restoreChargeScroll(list, position);
  }
  finishOpeningScreen(openingScreen);
}
function scrollToLatestCharges() {
  for (const list of root.querySelectorAll('.card-tab-panel:not([hidden]) .charge-list-scroll')) {
    list.scrollTop = 0;
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
    preferences = record?.document ?? emptyPreferences();
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
  const title = dialog.querySelector('h3');
  title.textContent = { income: 'Add income', savings: 'Add savings', bill: 'Add a bill', misc: 'Add miscellaneous item' }[view];
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
  const date = String(value ?? '').trim().replace(/^(\d{2})(\d{2})(\d{2}|\d{4})?$/, (_, month, day, year) =>
    year ? `${month}/${day}/${year}` : `${month}/${day}`);
  return parsePostedDate(date, selectedMonth.slice(0, 4));
}
function signedAmount(value) {
  const cents = toCents(String(value ?? '').trim().replace(/^\+(?=\d)/, '').replace(/^−/, '-'), true);
  if (!cents) throw new Error('Enter a nonzero amount.');
  return cents;
}
const queuedCharges = new WeakMap();
function readChargeDraft(form) {
  const vendor = form.elements.vendor.value.trim();
  const amountInput = form.elements.amount.value.trim();
  const category = form.elements.category.value;
  const important = form.elements.important.checked;
  if (!vendor && (!amountInput || amountInput === '-') && !category && !important) return null;
  if (!vendor) throw new Error('Enter a vendor.');
  const amountCents = toCents(amountInput, true);
  if (!amountCents) throw new Error('Enter a nonzero amount.');
  if (!Object.values(CC_CATEGORY_CODES).includes(category)) throw new Error('Choose a category code.');
  const postedDate = parseCardDate(form.elements.posted.value);
  return { vendor, amountCents, category, important, postedDate };
}
function updateChargeTotals(form) {
  form.querySelector('[data-action="flip-charge-sign"]').setAttribute('aria-pressed', String(form.elements.amount.value.trim().startsWith('-')));
  const rows = Array.from(form.querySelectorAll('.charge-draft-item'));
  const batch = rows.map(row => queuedCharges.get(row));
  let incomplete = false;
  try {
    const draft = readChargeDraft(form);
    if (draft) {
      const index = rows.findIndex(row => row.getAttribute('aria-pressed') === 'true');
      if (index < 0) batch.push(draft);
      else batch[index] = draft;
    }
  } catch {
    incomplete = true;
  }
  const cents = batch.reduce((sum, charge) => sum + charge.amountCents, 0);
  const count = batch.length;
  const save = form.querySelector('[type="submit"]');
  save.disabled = busy || (!count && !incomplete);
  save.textContent = count ? `Save ${count} ${count === 1 ? 'charge' : 'charges'} · ${money(cents)}` : 'Save charges';
}
function setChargeEditor(form, row = null) {
  const editor = form.querySelector('.charge-draft-editor');
  form.querySelector('.charge-draft-item[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
  const charge = queuedCharges.get(row);
  if (row) {
    row.setAttribute('aria-pressed', 'true');
    form.elements.posted.value = charge.postedDate ? `${charge.postedDate.slice(5).replace('-', '/')}/${charge.postedDate.slice(0, 4)}` : '';
  }
  form.elements.vendor.value = charge?.vendor ?? '';
  form.elements.amount.value = charge ? amount(charge.amountCents) : '';
  form.elements.category.value = charge?.category ?? '';
  form.elements.important.checked = charge?.important ?? false;
  editor.querySelector('[data-action="queue-charge"]').textContent = row ? 'Update charge' : '+ Add next';
  editor.querySelector('[data-action="remove-charge-draft"]').hidden = !row;
  updateChargeTotals(form);
}
function queueCharge(form, required = false) {
  const message = form.querySelector('.schedule-editor-error');
  message.textContent = '';
  let row = form.querySelector('.charge-draft-item[aria-pressed="true"]');
  try {
    const draft = readChargeDraft(form);
    if (!draft && !required && !row) return true;
    if (!draft) throw new Error('Enter a vendor and amount.');
    const previous = queuedCharges.get(row);
    if (!row) {
      row = document.createElement('button');
      row.type = 'button';
      row.className = 'charge-draft-item';
      row.dataset.action = 'edit-charge-draft';
      row.setAttribute('aria-pressed', 'false');
    }
    const code = Object.entries(CC_CATEGORY_CODES).find(([, name]) => name === draft.category)?.[0] ?? '—';
    const date = displayDate(draft.postedDate) || 'Pending';
    row.replaceChildren(...[code, draft.vendor + (draft.important ? ' ★' : ''), money(draft.amountCents), date].map(value => {
      const cell = document.createElement('span');
      cell.textContent = value;
      return cell;
    }));
    row.classList.toggle('charge-important', draft.important);
    queuedCharges.set(row, draft);
    if (required || !previous || Object.entries(draft).some(([key, value]) => previous[key] !== value)) {
      form.querySelector('.charge-draft-list').prepend(row);
    }
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
  for (const button of root.querySelectorAll('[data-payment-card]')) {
    button.hidden = button.dataset.paymentCard !== cardId;
  }
  scrollToLatestCharges();
}
function revealRowDelete(row = null) {
  const openRow = root.querySelector('.swipe-row-open');
  if (openRow === row) return;
  if (openRow) {
    openRow.classList.remove('swipe-row-open');
    openRow.querySelector('[data-swipe-delete]').hidden = true;
    openRow.querySelector('.checking-row-toggle')?.setAttribute('aria-expanded', 'false');
  }
  const button = row?.querySelector('[data-swipe-delete]:enabled');
  if (button) {
    row.classList.add('swipe-row-open');
    button.hidden = false;
    row.querySelector('.checking-row-toggle')?.setAttribute('aria-expanded', 'true');
  }
}
document.addEventListener('scroll', () => {
  root.querySelector('#charge-vendor-details:popover-open')?.hidePopover();
}, { capture: true, passive: true });
root.addEventListener('touchstart', event => {
  rowTouchStart = null;
  if (event.touches.length !== 1 ||
      event.target.closest('input, select, textarea, label, .charge-dialog:not(.card-month-activity), [data-swipe-delete]')) return;
  const row = event.target.closest('.charge-list:not(.is-editing) tr:is([data-charge-id], [data-payment-id]), .card-month-activity tr[data-payment-id], #edit-bills:not(.is-editing) .bill-list > li');
  const swipeRow = row?.querySelector('[data-swipe-delete]:enabled') ? row : null;
  if (!swipeRow && (window.matchMedia('(max-width: 759px)').matches ||
      !event.target.closest('[data-card-panel], .card-tabs'))) return;
  const { clientX, clientY } = event.touches[0];
  rowTouchStart = { clientX, clientY, row: swipeRow };
}, { passive: true });
root.addEventListener('touchend', event => {
  const start = rowTouchStart;
  rowTouchStart = null;
  if (!start || event.touches.length || !event.changedTouches.length) return;
  const { clientX, clientY } = event.changedTouches[0];
  const horizontal = clientX - start.clientX;
  if (Math.abs(horizontal) < 55 || Math.abs(horizontal) <= Math.abs(clientY - start.clientY) * 1.5) return;
  if (start.row) {
    if (start.row.isConnected) revealRowDelete(horizontal < 0 ? start.row : null);
    return;
  }
  selectCard(horizontal < 0 ? cardTabs[1].id : cardTabs[0].id);
}, { passive: true });
root.addEventListener('touchcancel', () => { rowTouchStart = null; });
root.addEventListener('input', event => {
  event.target.setCustomValidity?.('');
  const form = event.target.form;
  if (form?.id === 'add-bill' && event.target.name === 'name' && !form.dataset.debitDayChosen) {
    const endOfMonth = /\b(?:mortgage|hoa)\b|\bhomeowners[’']? association\b/i.test(event.target.value);
    form.elements.day.value = endOfMonth ? 'eom' : '1';
  }
  if (form?.matches('.charge-batch-form')) {
    form.querySelector('.schedule-editor-error').textContent = '';
    updateChargeTotals(form);
  }
});
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
        input.dispatchEvent(new Event('input', { bubbles: true }));
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
  if (input.form?.id === 'add-bill' && input.name === 'day') input.form.dataset.debitDayChosen = 'true';
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
  if (form.dataset.cardPayment || form.id === 'edit-card-payment') {
    const message = form.querySelector('.schedule-editor-error');
    try {
      const paymentId = form.dataset.paymentId;
      const previous = paymentId ? rowById(budget.cardPayments, paymentId) : null;
      const card = cardStatementPayments(budget).find(item => item.id === (previous?.card ?? form.dataset.cardPayment));
      const day = scheduleItemDay(fields.get('date'));
      const amountCents = previous || fields.get('paymentType') === 'partial' ? toCents(fields.get('amount')) : card.amountCents;
      const maximum = card.amountCents + (previous?.amountCents ?? 0);
      if (amountCents <= 0 || amountCents > maximum) {
        throw new Error(`Enter a payment greater than zero and no more than ${money(maximum)}.`);
      }
      await commit(next => {
        if (previous) Object.assign(rowById(next.cardPayments, paymentId), { day, amountCents });
        else (next.cardPayments ??= []).push({ id: id(), card: card.id, day, amountCents });
      });
    } catch (cause) { message.textContent = cause.message; }
    return;
  }
  if (form.id === 'edit-bills') {
    if (!form.classList.contains('is-editing')) return;
    const message = form.querySelector('.schedule-editor-error');
    message.textContent = '';
    const lastDay = daysInMonth(selectedMonth);
    try {
      const bills = budget.bills.map(bill => {
        try {
          const name = fields.get('name-' + bill.id).trim();
          if (!name) throw new Error('Enter a vendor.');
          const debitDay = fields.get('day-' + bill.id);
          const endOfMonth = debitDay === 'eom';
          const day = endOfMonth ? lastDay : validateDay(debitDay, selectedMonth);
          const amountCents = toCents(fields.get('amount-' + bill.id));
          const paid = fields.has('paid-' + bill.id);
          return { ...bill, name, day, amountCents, paid, endOfMonth };
        } catch (cause) {
          throw new Error(bill.name + ' · ' + cause.message);
        }
      });
      const checkingItems = (budget.checkingItems ?? []).map(item => {
        const name = fields.get('misc-name-' + item.id).trim();
        if (!name) throw new Error('Enter a description for ' + item.name + '.');
        const day = validateDay(fields.get('misc-day-' + item.id), selectedMonth);
        const amountCents = signedAmount(fields.get('misc-amount-' + item.id));
        return { ...item, name, day, amountCents };
      });
      await commit(next => {
        next.bills = bills;
        if (next.checkingItems) next.checkingItems = checkingItems;
      });
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
    for (const row of form.querySelectorAll('tr[data-charge-id]')) {
      const key = row.dataset.chargeId;
      const previous = rowById(budget.charges, key);
      try {
        const vendor = fields.get('vendor-' + key).trim();
        if (!vendor) throw new Error('Enter a vendor.');
        const dateText = fields.get('posted-' + key).trim();
        const postedDate = dateText === displayDate(previous.postedDate) ? previous.postedDate ?? null : parseCardDate(dateText);
        const amountCents = toCents(fields.get('amount-' + key), true);
        const category = fields.get('category-' + key) ?? previous.category;
        const important = fields.get('important-' + key) === 'on';
        updates.set(key, { ...previous, vendor, postedDate, amountCents, category, important });
      } catch (cause) {
        message.textContent = `${previous.vendor}: ${cause.message}`;
        return;
      }
    }
    await commit(next => {
      next.charges = next.charges.map(charge => updates.get(charge.id) ?? charge);
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
    // Store drafts from oldest to newest so saved activity can show the latest first.
    const charges = rows.reverse().map(row => ({ ...queuedCharges.get(row), id: id(), card: activeCard }));
    await commit(next => { next.charges.push(...charges); });
    return;
  }
  if (form.id === 'add-savings') {
    const message = form.querySelector('.schedule-editor-error');
    try {
      message.textContent = '';
      const day = scheduleItemDay(fields.get('date'));
      const amountCents = signedAmount(fields.get('amount'));
      const transfer = { id: id(), day, amountCents };
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
        const amountCents = signedAmount(fields.get('savings-amount-' + index));
        return [{ ...transfer, day, amountCents }];
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
  if (form.id === 'add-checking-item') {
    const message = form.querySelector('.schedule-editor-error');
    try {
      message.textContent = '';
      const name = fields.get('name').trim();
      if (!name) throw new Error('Enter a description.');
      const day = scheduleItemDay(fields.get('date'));
      const amountCents = signedAmount(fields.get('amount'));
      await commit(next => { (next.checkingItems ??= []).push({ id: id(), name, day, amountCents }); });
    } catch (cause) {
      message.textContent = cause.message;
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
  if (!event.target.closest('.charge-swipe-delete, .charge-dialog:not(.card-month-activity), .checking-row-toggle')) revealRowDelete();
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'toggle-schedule-section') {
    const sectionId = button.getAttribute('aria-controls');
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    scheduleSectionOverrides.set(sectionId, expanded);
    button.setAttribute('aria-expanded', String(expanded));
    document.getElementById(sectionId).toggleAttribute('data-collapsed', !expanded);
    return;
  }
  if (action === 'open-bill-breakdown') {
    document.getElementById(button.getAttribute('aria-controls')).showModal();
    return;
  }
  if (action === 'open-card-payments') {
    document.getElementById(button.getAttribute('aria-controls')).showModal();
    return;
  }
  if (action === 'edit-card-payment') {
    if (busy || budget.closed) return;
    const payment = rowById(budget.cardPayments, button.closest('[data-payment-id]').dataset.paymentId);
    const dialog = root.querySelector('#edit-card-payment-dialog');
    const form = dialog.querySelector('form');
    form.dataset.paymentId = payment.id;
    form.elements.amount.value = amount(payment.amountCents);
    form.elements.date.value = `${selectedMonth}-${String(payment.day).padStart(2, '0')}`;
    form.querySelector('.schedule-editor-error').textContent = '';
    dialog.querySelector('[data-payment-card-name]').textContent = cardTabs.find(card => card.id === payment.card).name;
    dialog.showModal();
    return;
  }
  if (action === 'position-add-menu') {
    const menu = document.getElementById(button.getAttribute('popovertarget'));
    const bounds = button.getBoundingClientRect();
    const viewportHeight = document.documentElement.clientHeight;
    const openAbove = viewportHeight - bounds.bottom < 170 && bounds.top > viewportHeight - bounds.bottom;
    menu.style.setProperty('--add-menu-left', `${bounds.left}px`);
    menu.style.top = openAbove ? 'auto' : `${bounds.bottom + 4}px`;
    menu.style.bottom = openAbove ? `${viewportHeight - bounds.top + 4}px` : 'auto';
    return;
  }
  if (action === 'open-item-dialog') {
    const dialog = document.getElementById(button.getAttribute('aria-controls'));
    button.closest('.panel-add-menu').hidePopover();
    for (const form of dialog.querySelectorAll('form')) {
      form.reset();
      delete form.dataset.debitDayChosen;
      form.querySelector('.schedule-editor-error').textContent = '';
    }
    setScheduleItemView(dialog, button.dataset.item);
    dialog.showModal();
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
  if (action === 'open-card-month-activity' || action === 'open-card-expense-summary') {
    const card = cardTabs.find(card => card.id === activeCard);
    const charges = budget.charges.filter(charge => charge.card === card.id);
    const summary = action === 'open-card-expense-summary';
    const dialog = root.querySelector('#card-month-activity');
    dialog.querySelector('h3').textContent = card.name + (summary ? ' summary' : ' activity');
    dialog.querySelector('[data-activity-cycle]').textContent = 'Statement cycle · ' + cardCycleDates(card);
    const list = dialog.querySelector('.card-month-activity-list');
    list.setAttribute('aria-label', summary ? 'Credit card expenses by code' : 'Full credit card transactions');
    list.innerHTML = summary ? cardExpenseSummary(charges) : cardChargeTable(charges, card.id, true);
    dialog.showModal();
    list.scrollTop = 0;
    return;
  }
  if (action === 'show-charge-vendor') {
    const popover = root.querySelector('#charge-vendor-details');
    const anchor = button.getBoundingClientRect();
    const viewportHeight = document.documentElement.clientHeight;
    const viewportWidth = document.documentElement.clientWidth;
    const left = Math.max(8, Math.min(anchor.left, viewportWidth - 168));
    const above = anchor.bottom > viewportHeight / 2;
    popover.textContent = button.textContent;
    popover.style.setProperty('--vendor-popover-left', left + 'px');
    popover.style.top = above ? 'auto' : anchor.bottom + 4 + 'px';
    popover.style.bottom = above ? viewportHeight - anchor.top + 4 + 'px' : 'auto';
    return;
  }
  if (action === 'confirm-row-removal') {
    if (busy || budget.closed) return;
    const { chargeId, billId, checkingId, paymentId } = button.closest('tr, li').dataset;
    const collection = chargeId ? 'charges' : billId ? 'bills' : checkingId ? 'checkingItems' : 'cardPayments';
    const entry = rowById(budget[collection], chargeId ?? billId ?? checkingId ?? paymentId);
    const card = cardTabs.find(item => item.id === entry.card);
    const name = entry.vendor ?? entry.name ?? `${card?.name ?? 'Card'} payment`;
    const date = chargeId ? displayDate(entry.postedDate) || 'Pending' : `${Number(selectedMonth.slice(5))}/${entry.day}`;
    const dialog = root.querySelector('#entry-delete-dialog');
    dialog.dataset.collection = collection;
    dialog.dataset.entryId = entry.id;
    dialog.querySelector('#entry-delete-details').textContent = [name, money(entry.amountCents), date].join(' · ');
    dialog.showModal();
    return;
  }
  if (action === 'delete-confirmed-row') {
    const dialog = button.closest('dialog');
    if (!dialog.open || busy || budget.closed) return;
    const { collection, entryId } = dialog.dataset;
    dialog.close();
    revealRowDelete();
    await commit(next => {
      next[collection] = next[collection].filter(entry => entry.id !== entryId);
    });
    return;
  }
  if (action === 'queue-charge') {
    if (queueCharge(button.form, true)) button.form.elements.vendor.focus();
    return;
  }
  if (action === 'flip-charge-sign') {
    const field = button.form.elements.amount;
    const value = field.value.trim();
    field.value = value.startsWith('-') ? value.slice(1) : '-' + value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (action === 'edit-charge-draft') {
    if (button.getAttribute('aria-pressed') === 'true' || !queueCharge(button.form)) return;
    setChargeEditor(button.form, button);
    button.focus({ preventScroll: true });
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
  if (action === 'edit-bills' || action === 'edit-charges' || action === 'edit-schedule') {
    const form = button.form;
    const chargeList = form.querySelector('.charge-list-scroll');
    const position = chargeList && chargeScrollPosition(chargeList);
    form.classList.add('is-editing');
    if (chargeList) {
      chargeList.focus({ preventScroll: true });
      restoreChargeScroll(chargeList, position);
    } else {
      form.tabIndex = -1;
      form.focus({ preventScroll: true });
    }
    return;
  }
  if (action === 'cancel-bill-edits') {
    const form = button.form;
    form.reset();
    form.querySelector('.schedule-editor-error').textContent = '';
    form.classList.remove('is-editing');
    form.querySelector('[data-action="edit-bills"]').focus();
    return;
  }
  if (action === 'toggle-checking-removal') {
    const row = button.closest('li');
    const open = !row.classList.contains('swipe-row-open');
    revealRowDelete(open ? row : null);
    if (open && event.detail === 0) row.querySelector('[data-swipe-delete]').focus();
    return;
  }
  if (action === 'cancel-charge-edits') {
    const form = button.form;
    const list = form.querySelector('.charge-list-scroll');
    const position = chargeScrollPosition(list);
    form.reset();
    form.querySelector('.schedule-editor-error').textContent = '';
    form.classList.remove('is-editing');
    form.querySelector('[data-action="edit-charges"]').focus({ preventScroll: true });
    restoreChargeScroll(list, position);
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
  if (action === 'reopen-month') return commit(next => { next.closed = false; }, true);
});
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
if (supabase) {
  showOpeningScreen();
  supabase.auth.getSession().then(({ data, error: cause }) => { if (cause) { error = cause.message; loading = false; renderAuth(); } else start(data.session); });
  supabase.auth.onAuthStateChange((_event, session) => { if ((session?.user?.id ?? null) !== (activeUser?.id ?? null)) setTimeout(() => start(session), 0); });
} else start(null);
