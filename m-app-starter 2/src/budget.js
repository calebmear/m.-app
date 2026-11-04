export const CATEGORIES = ['Uncategorized', 'Groceries', 'Dining', 'Household', 'Shopping', 'Health', 'Travel', 'Other'];
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
export function toCents(value, allowNegative = false) {
  const text = String(value).trim().replace(/[$,]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new Error('Enter an amount with no more than two decimal places.');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || (!allowNegative && negative)) throw new Error('Enter a valid amount of zero or more.');
  return negative ? -cents : cents;
}
export function parsePostedDate(value) {
  const text = String(value).trim();
  if (!text) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (!match) throw new Error('Use MM/DD/YY, or leave the date blank for pending.');
  const month = Number(match[1]), day = Number(match[2]);
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('Enter a real calendar date as MM/DD/YY.');
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
  return { schemaVersion: 1, paychecks: [{ name: 'Paycheck 1', day: 6, amountCents: 0 }, { name: 'Paycheck 2', day: 20, amountCents: 0 }], bills: [] };
}
export function createMonth(month, preferences = emptyPreferences()) {
  const last = daysInMonth(month);
  return {
    schemaVersion: 1, month, openingCents: 0, closed: false,
    paychecks: preferences.paychecks.map(p => ({ id: id(), name: p.name, day: p.endOfMonth ? last : Math.min(p.day, last), amountCents: p.amountCents, received: false })),
    bills: preferences.bills.map(b => ({ id: id(), name: b.name, day: b.endOfMonth ? last : Math.min(b.day, last), amountCents: b.amountCents, paid: false, endOfMonth: Boolean(b.endOfMonth) })),
    charges: [], statement: { amountCents: 0, paymentDay: Math.min(19, last), dueDay: Math.min(20, last), paid: false }
  };
}
export function preferencesFromMonth(document) {
  return { schemaVersion: 1, paychecks: document.paychecks.map(({ name, day, amountCents }) => ({ name, day, amountCents })), bills: document.bills.map(({ name, day, amountCents, endOfMonth }) => ({ name, day, amountCents, endOfMonth })) };
}
export function sortedCharges(charges) {
  return charges.map((charge, index) => ({ ...charge, originalIndex: index })).sort((a, b) => a.postedDate && b.postedDate ? b.postedDate.localeCompare(a.postedDate) || a.originalIndex - b.originalIndex : a.postedDate ? -1 : b.postedDate ? 1 : a.originalIndex - b.originalIndex);
}
export function reserveDay(document) {
  // Pending activity is already committed cash. Place it in today's interval
  // for the current month; historical/future monthly views reserve it at day 1.
  if (document.month !== currentMonth()) return 1;
  return Number(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'America/New_York' }).format(new Date()));
}
export function eventsForMonth(document) {
  const events = [
    ...document.paychecks.map(p => ({ day: p.day, amountCents: p.amountCents, kind: 'pay', priority: 0 })),
    ...document.bills.map(b => ({ day: b.day, amountCents: -b.amountCents, kind: 'bill', priority: 1 })),
    { day: document.statement.paymentDay, amountCents: -document.statement.amountCents, kind: 'statement', priority: 1 },
    ...document.charges.map(c => ({ day: c.postedDate?.startsWith(document.month + '-') ? Number(c.postedDate.slice(-2)) : reserveDay(document), amountCents: -c.amountCents, kind: 'card', priority: 2 }))
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
  const rows = [{ kind: 'opening', label: 'Beginning checking', amountCents: rolling }];
  const add = (label, amountCents, kind = 'expense', extra = {}) => { rolling += amountCents; rows.push({ label, amountCents, kind, ...extra }); };
  const checkpoint = label => rows.push({ kind: 'balance', label, amountCents: rolling });
  const numericMonth = Number(document.month.slice(5));
  const dayLabel = day => `${numericMonth}/${day}`;
  function period(start, end) {
    const bills = document.bills.filter(b => b.day >= start && b.day < end);
    const ordinary = bills.filter(b => !b.endOfMonth).reduce((total, b) => total + b.amountCents, 0);
    if (ordinary) add('Bills', -ordinary);
    bills.filter(b => b.endOfMonth).forEach(b => add(b.name, -b.amountCents));
    const reserved = eventsForMonth(document).filter(e => e.kind === 'card' && e.day >= start && e.day < end).reduce((total, e) => total - e.amountCents, 0);
    if (reserved) add('CC activity · reserved', -reserved);
    if (document.statement.paymentDay >= start && document.statement.paymentDay < end && document.statement.amountCents) add(`${dayLabel(document.statement.paymentDay)} CC statement`, -document.statement.amountCents);
  }
  const paydays = [...new Set(document.paychecks.map(p => p.day))].sort((a, b) => a - b);
  if (!paydays.length) { period(1, daysInMonth(document.month) + 1); return rows; }
  period(1, paydays[0]);
  if (paydays[0] > 1) { checkpoint('Rollover'); rows.push({ kind: 'gap' }); }
  paydays.forEach((day, index) => {
    document.paychecks.filter(p => p.day === day).forEach(p => add(`${dayLabel(day)} ${p.name}`, p.amountCents, 'pay', { pay: p }));
    checkpoint(`${dayLabel(day)} Checking`);
    period(day, paydays[index + 1] ?? daysInMonth(document.month) + 1);
    if (index < paydays.length - 1) { checkpoint('Rollover'); rows.push({ kind: 'gap' }); }
  });
  return rows;
}
export function validateDocument(document) {
  if (document?.schemaVersion !== 1 || !validMonth(document.month)) throw new Error('This budget uses an unsupported format.');
  const safeCents = cents => Number.isSafeInteger(cents);
  if (!safeCents(document.openingCents)) throw new Error('Invalid beginning balance.');
  for (const key of ['paychecks', 'bills', 'charges']) {
    if (!Array.isArray(document[key])) throw new Error(`Invalid ${key}.`);
    const seen = new Set();
    for (const row of document[key]) {
      if (typeof row.id !== 'string' || !row.id || seen.has(row.id) || !safeCents(row.amountCents)) throw new Error(`Invalid ${key} entry.`);
      seen.add(row.id);
      if (key !== 'charges') { validateDay(row.day, document.month); if (row.amountCents < 0 || !String(row.name).trim()) throw new Error('Invalid bill or paycheck.'); }
      else {
        if (!String(row.vendor).trim()) throw new Error('Enter a vendor.');
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
