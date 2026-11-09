export const CC_CATEGORY_CODES = {
  X: 'Christmas',
  G: 'Grocery',
  B: 'Birthday',
  S: 'Shopping',
  D: 'Dining',
  C: 'Coffee',
  F: 'Fuel',
  H: 'Home/Health',
  L: 'Letters&Loops',
  M: 'Misc',
  U: 'USX',
  T: 'Travel',
};
export const CATEGORIES = ['Uncategorized', ...Object.values(CC_CATEGORY_CODES)];
export const CARDS = [
  { id: 'amex', name: 'Amex', dueDay: 17 },
  { id: 'capone', name: 'CapOne', dueDay: 21 },
];
export const copy = value => JSON.parse(JSON.stringify(value));
export const id = () => globalThis.crypto.randomUUID();
export const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export function currentMonth() {
  const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', timeZone: 'America/New_York' }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}
export function validMonth(month) { return /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month); }
export function daysInMonth(month) {
  if (!validMonth(month)) throw new Error('Choose a valid budget month.');
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}
export function monthLabel(month, style = 'long') {
  return new Intl.DateTimeFormat('en-US', { month: style, year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));
}
export function shortMonth(month) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));
}
export function nextMonth(month) {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function cardStatementCycle(month, closingDay = 21) {
  const until = month + '-' + String(closingDay).padStart(2, '0');
  const date = new Date(until + 'T12:00:00Z');
  date.setUTCMonth(date.getUTCMonth() - 1);
  return { from: date.toISOString().slice(0, 10), until };
}

export function cardStatementPayments(document) {
  return CARDS.map(card => {
    const total = document.charges
      .filter(charge => charge.card === card.id)
      .reduce((sum, charge) => sum + charge.amountCents, 0);
    return { ...card, amountCents: Math.max(0, total) };
  });
}
export function toCents(value, allowNegative = false) {
  const text = String(value).trim().replace(/[$,]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new Error('Enter an amount with no more than two decimal places.');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || (!allowNegative && negative)) throw new Error('Enter a valid amount of zero or more.');
  return negative ? -cents : cents;
}
export function parsePostedDate(value, defaultYear) {
  const text = String(value).trim();
  if (!text) return null;
  const match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(text);
  if (!match) throw new Error('Use MM/DD or MM/DD/YY, or leave the date blank for pending.');
  const month = Number(match[1]), day = Number(match[2]);
  const enteredYear = match[3];
  if (!enteredYear && !defaultYear) throw new Error('Enter a year for this date.');
  const year = enteredYear?.length === 2 ? 2000 + Number(enteredYear) : Number(enteredYear ?? defaultYear);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('Enter a real calendar date.');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function displayDate(date) {
  if (!date) return '';
  const [year, month, day] = date.split('-');
  return `${month}/${day}/${year.slice(-2)}`;
}
export function validateDay(value, month) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(month)) throw new Error(`Enter a day from 1 to ${daysInMonth(month)}.`);
  return day;
}
export function emptyPreferences() {
  return {
    schemaVersion: 1,
    paycheckCadence: 'biweekly',
    paychecks: [
      { name: 'C pay', amountCents: 220000 },
      { name: 'A pay', amountCents: 185000 },
    ],
    bills: [],
  };
}
export function hasLegacyPaycheckDefaults(paychecks) {
  return paychecks.length === 2 && paychecks.every((pay, index) =>
    pay.name === 'Paycheck ' + (index + 1) && pay.day === 6 + 14 * index &&
    pay.amountCents === 0 && !pay.received && !pay.endOfMonth
  );
}
export function createMonth(month, preferences = emptyPreferences()) {
  const last = daysInMonth(month);
  let paychecks = preferences.paychecks;
  const hasLegacyDefaults = hasLegacyPaycheckDefaults(paychecks);
  if (preferences.paycheckCadence === 'biweekly' || hasLegacyDefaults) {
    const templates = hasLegacyDefaults ? emptyPreferences().paychecks : paychecks;
    const paydayAnchor = Date.UTC(2026, 10, 6);
    const daysFromAnchor = (Date.parse(month + '-01T00:00:00Z') - paydayAnchor) / 86400000;
    const firstPayday = 1 + ((-daysFromAnchor % 14) + 14) % 14;
    paychecks = [];
    for (let day = firstPayday; day <= last; day += 14) {
      paychecks.push(...templates.map(pay => ({ ...pay, day })));
    }
  }
  return {
    schemaVersion: 1, month, openingCents: 0, closed: false,
    paychecks: paychecks.map(p => ({ id: id(), name: p.name, day: p.endOfMonth ? last : Math.min(p.day, last), amountCents: p.amountCents, received: false })),
    bills: preferences.bills.map(b => ({ id: id(), name: b.name, day: b.endOfMonth ? last : Math.min(b.day, last), amountCents: b.amountCents, paid: false, endOfMonth: Boolean(b.endOfMonth) })),
    charges: [], statement: { amountCents: 0, paymentDay: Math.min(19, last), dueDay: Math.min(20, last), paid: false }
  };
}
export function preferencesFromMonth(document) {
  return { schemaVersion: 1, paychecks: document.paychecks.map(({ name, day, amountCents }) => ({ name, day, amountCents })), bills: document.bills.map(({ name, day, amountCents, endOfMonth }) => ({ name, day, amountCents, endOfMonth })) };
}
export function sortedCharges(charges) {
  return charges.slice().sort((a, b) => {
    if (!a.postedDate) return b.postedDate ? 1 : 0;
    if (!b.postedDate) return -1;
    return a.postedDate.localeCompare(b.postedDate);
  });
}
export function reserveDay(document) {
  // Pending activity is already committed cash. Place it in today's interval
  // for the current month; historical/future monthly views reserve it at day 1.
  if (document.month !== currentMonth()) return 1;
  return Number(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'America/New_York' }).format(new Date()));
}
export function etsyDepositDays(document) {
  const days = new Set(Object.keys(document.etsyDeposits ?? {}).map(Number));
  const [year, month] = document.month.split('-').map(Number);
  for (const paycheck of document.paychecks) {
    const friday = new Date(Date.UTC(year, month - 1, paycheck.day)).getUTCDay() === 5;
    if (friday && paycheck.day > 4) days.add(paycheck.day - 4);
  }
  return [...days].sort((a, b) => a - b);
}
export function eventsForMonth(document) {
  const events = [
    ...document.paychecks.map(p => ({ day: p.day, amountCents: p.amountCents, kind: 'pay', priority: 0 })),
    ...Object.entries(document.etsyDeposits ?? {}).map(([day, amountCents]) => ({ day: Number(day), amountCents, kind: 'etsy', priority: 0 })),
    ...(document.savingsTransfers ?? []).map(({ day, amountCents }) => ({
      day, amountCents, kind: 'savings', priority: amountCents > 0 ? 0 : 1,
    })),
    ...document.bills.map(b => ({ day: b.day, amountCents: -b.amountCents, kind: 'bill', priority: 1 })),
    { day: document.statement.paymentDay, amountCents: -document.statement.amountCents, kind: 'statement', priority: 1 },
    ...cardStatementPayments(document).filter(card => card.amountCents).map(card => ({
      day: card.dueDay, amountCents: -card.amountCents, kind: 'statement', priority: 1,
    })),
    ...document.charges.filter(c => !c.card).map(c => ({ day: c.postedDate?.startsWith(document.month + '-') ? Number(c.postedDate.slice(-2)) : reserveDay(document), amountCents: -c.amountCents, kind: 'card', priority: 2 }))
  ];
  return events.sort((a, b) => a.day - b.day || a.priority - b.priority);
}
export function totals(document) {
  const sum = rows => rows.reduce((total, row) => total + row.amountCents, 0);
  const posted = sum(document.charges.filter(c => c.postedDate));
  const pending = sum(document.charges.filter(c => !c.postedDate));
  const checking = document.openingCents + sum(document.paychecks.filter(p => p.received)) - sum(document.bills.filter(b => b.paid)) - (document.statement.paid ? document.statement.amountCents : 0);
  let ending = document.openingCents, lowest = ending;
  for (const event of eventsForMonth(document)) { ending += event.amountCents; lowest = Math.min(lowest, ending); }
  return { checking, ending, lowest, posted, pending, reserved: posted + pending, remainingBills: sum(document.bills.filter(b => !b.paid)) };
}
export function compactSchedule(document) {
  let rolling = document.openingCents;
  const rows = [{ kind: 'opening', day: 1, label: 'Checking start', amountCents: rolling }];
  const add = (day, label, amountCents, kind = 'expense', extra = {}) => {
    rolling += amountCents;
    rows.push({ day, label, amountCents, kind, ...extra });
  };
  const lastDay = daysInMonth(document.month);
  const cardEvents = eventsForMonth(document).filter(event => event.kind === 'card');
  const cardPayments = cardStatementPayments(document);
  const transfersAndDeposits = [
    ...etsyDepositDays(document).map(day => ({
      day, label: 'Etsy deposit', amountCents: document.etsyDeposits?.[day] ?? 0, kind: 'etsy',
    })),
    ...(document.savingsTransfers ?? []).map(({ day, amountCents }) => ({
      day, label: amountCents < 0 ? 'Transfer to savings' : 'Withdrawal from savings', amountCents, kind: 'savings',
    })),
  ].sort((a, b) => a.day - b.day);
  const lastCardDueDay = Math.max(...cardPayments.map(card => card.dueDay));
  const checkpointDays = [...new Set([...document.paychecks.map(pay => pay.day), lastCardDueDay])].sort((a, b) => a - b);

  function addExpenses(start, end) {
    const inPeriod = entry => entry.day >= start && entry.day <= end;
    const bills = document.bills.filter(inPeriod);
    const ordinary = bills.filter(bill => !bill.endOfMonth).reduce((total, bill) => total + bill.amountCents, 0);
    const billDetails = { expenseType: 'bill' };
    add(end, 'Bills', ordinary ? -ordinary : 0, 'expense', billDetails);
    bills.filter(bill => bill.endOfMonth).forEach(bill => add(bill.day, bill.name, -bill.amountCents, 'expense', billDetails));
    const reserved = cardEvents.filter(inPeriod).reduce((total, event) => total + event.amountCents, 0);
    const cardDetails = { expenseType: 'card' };
    if (reserved) add(end, 'CC activity · reserved', reserved, 'expense', cardDetails);
    const { paymentDay, amountCents } = document.statement;
    if (amountCents && paymentDay >= start && paymentDay <= end) add(paymentDay, 'CC statement', -amountCents, 'expense', cardDetails);
    for (const card of cardPayments) {
      if (card.dueDay >= start && card.dueDay <= end) {
        add(card.dueDay, card.name + ' due', card.amountCents ? -card.amountCents : 0, 'expense', cardDetails);
      }
    }
  }

  function addTransfersAndDeposits(start, end) {
    for (const { day, label, amountCents, kind } of transfersAndDeposits) {
      if (day >= start && day <= end) add(day, label, amountCents, kind);
    }
  }

  function checkpoint(day) {
    const label = day === lastDay ? 'Rollover' : 'Checking balance';
    rows.push({ kind: 'balance', day, label, amountCents: rolling });
  }

  let start = 1;
  for (const day of checkpointDays) {
    addTransfersAndDeposits(start, day);
    addExpenses(start, day);
    for (const pay of document.paychecks.filter(pay => pay.day === day)) {
      add(day, pay.name, pay.amountCents, 'pay', { pay });
    }
    // Use the balance after the card payment when payday is one day before it.
    if (day !== lastCardDueDay - 1) checkpoint(day);
    start = day + 1;
  }
  if (start <= lastDay) {
    addTransfersAndDeposits(start, lastDay);
    addExpenses(start, lastDay);
    checkpoint(lastDay);
  }
  return rows;
}
export function validateDocument(document) {
  if (document?.schemaVersion !== 1 || !validMonth(document.month)) throw new Error('This budget uses an unsupported format.');
  const safeCents = cents => Number.isSafeInteger(cents);
  if (!safeCents(document.openingCents)) throw new Error('Invalid beginning balance.');
  if (document.etsyDeposits !== undefined) {
    if (!document.etsyDeposits || typeof document.etsyDeposits !== 'object' || Array.isArray(document.etsyDeposits)) throw new Error('Invalid Etsy deposits.');
    for (const [day, cents] of Object.entries(document.etsyDeposits)) {
      if (!/^[1-9]\d?$/.test(day) || !safeCents(cents) || cents < 0) throw new Error('Invalid Etsy deposit.');
      validateDay(day, document.month);
    }
  }
  for (const key of ['paychecks', 'bills', 'charges', 'savingsTransfers']) {
    if (key === 'savingsTransfers' && document[key] === undefined) continue;
    if (!Array.isArray(document[key])) throw new Error(`Invalid ${key}.`);
    const seen = new Set();
    for (const row of document[key]) {
      if (typeof row.id !== 'string' || !row.id || seen.has(row.id) || !safeCents(row.amountCents)) throw new Error(`Invalid ${key} entry.`);
      seen.add(row.id);
      if (key === 'savingsTransfers') {
        validateDay(row.day, document.month);
        if (!row.amountCents) throw new Error('Enter a nonzero savings transfer.');
      }
      else if (key !== 'charges') { validateDay(row.day, document.month); if (row.amountCents < 0 || !String(row.name).trim()) throw new Error('Invalid bill or paycheck.'); }
      else {
        if (!String(row.vendor).trim()) throw new Error('Enter a vendor.');
        if (row.card && !CARDS.some(card => card.id === row.card)) throw new Error('Choose a valid credit card.');
        if (row.postedDate) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(row.postedDate)) throw new Error('Invalid posted date.');
          const [year, month, day] = row.postedDate.split('-');
          if (parsePostedDate(`${month}/${day}/${year}`) !== row.postedDate) throw new Error('Invalid posted date.');
        }
      }
    }
  }
  if (!document.statement || !safeCents(document.statement.amountCents) || document.statement.amountCents < 0) throw new Error('Invalid statement balance.');
  validateDay(document.statement.paymentDay, document.month); validateDay(document.statement.dueDay, document.month);
  return document;
}
