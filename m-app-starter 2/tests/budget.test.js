import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonth, emptyPreferences, preferencesFromMonth, totals, compactSchedule, parsePostedDate, displayDate, toCents, sortedCharges, nextMonth, validateDocument } from '../src/budget.js';

function fixture() {
  const month = createMonth('2026-11');
  month.openingCents = 80000;
  month.paychecks = [{ id: 'pay', name: 'Pay', day: 6, amountCents: 100000, received: true }];
  month.bills = [{ id: 'rent', name: 'Bill', day: 10, amountCents: 40000, paid: false }];
  month.charges = [{ id: 'card', vendor: 'Grocer', amountCents: 7542, postedDate: null, category: 'Groceries' }];
  month.statement.amountCents = 20000;
  return month;
}
test('money is parsed as exact cents, including refunds', () => {
  assert.equal(toCents('1,234.56'), 123456);
  assert.equal(toCents('0.29'), 29);
  assert.equal(toCents('-12.34', true), -1234);
  assert.throws(() => toCents('12.345'));
  assert.throws(() => toCents(''));
  assert.throws(() => toCents('-1'));
});
test('typed dates validate calendar days and blank means pending', () => {
  assert.equal(parsePostedDate('11/9/26'), '2026-11-09');
  assert.equal(displayDate('2026-11-09'), '11/09/26');
  assert.equal(parsePostedDate(''), null);
  assert.equal(parsePostedDate('02/29/28'), '2028-02-29');
  assert.throws(() => parsePostedDate('02/29/26'));
  assert.throws(() => parsePostedDate('13/01/26'));
});
test('marking a scheduled bill paid changes checking, not forecast', () => {
  const month = fixture(), before = totals(month);
  assert.equal(before.ending, 112458);
  assert.equal(before.checking, 180000);
  month.bills[0].paid = true;
  assert.equal(totals(month).checking, 140000);
  assert.equal(totals(month).ending, before.ending);
});
test('posting pending card activity does not deduct twice', () => {
  const month = fixture(), before = totals(month);
  month.charges[0].postedDate = '2026-11-09';
  const after = totals(month);
  assert.equal(after.ending, before.ending);
  assert.equal(after.reserved, 7542);
  assert.equal(after.pending, 0);
  assert.equal(after.posted, 7542);
});
test('clearing previous statement payment changes checking only', () => {
  const month = fixture(), before = totals(month);
  month.statement.paid = true;
  assert.equal(totals(month).checking, before.checking - 20000);
  assert.equal(totals(month).ending, before.ending);
});
test('new card activity immediately reduces forecast; refunds release it', () => {
  const month = fixture(), before = totals(month).ending;
  month.charges.push({ id: 'refund', vendor: 'Refund', amountCents: -2542, postedDate: null, category: 'Other' });
  assert.equal(totals(month).ending, before + 2542);
  assert.equal(totals(month).reserved, 5000);
});
test('new months copy defaults and never share mutable entries', () => {
  const defaults = emptyPreferences();
  defaults.bills = [{ name: 'Mortgage', day: 30, amountCents: 100000, endOfMonth: true }];
  const feb = createMonth('2027-02', defaults), leap = createMonth('2028-02', defaults), march = createMonth('2027-03', defaults);
  assert.equal(feb.bills[0].day, 28);
  assert.equal(leap.bills[0].day, 29);
  assert.equal(march.bills[0].day, 31);
  feb.bills[0].amountCents = 120000;
  feb.paychecks[0].amountCents = 300000;
  assert.equal(march.bills[0].amountCents, 100000);
  assert.equal(march.paychecks[0].amountCents, 0);
  assert.deepEqual(march.charges, []);
  assert.equal(march.statement.amountCents, 0);
  assert.equal(march.bills[0].paid, false);
  assert.equal(preferencesFromMonth(feb).bills[0].amountCents, 120000);
});
test('ledger sorts posted newest first, retaining undated charges at bottom', () => {
  const rows = sortedCharges([{ id:'a', postedDate:null }, { id:'b', postedDate:'2026-11-08' }, { id:'c', postedDate:'2026-11-09' }, { id:'d', postedDate:null }]);
  assert.deepEqual(rows.map(row => row.id), ['c', 'b', 'a', 'd']);
});
test('a positive ending does not hide a shortfall before payday', () => {
  const month = createMonth('2026-11');
  month.bills = [{ id: 'bill', name: 'Bill', day: 2, amountCents: 10000, paid: false }];
  month.paychecks[0].amountCents = 50000;
  assert.equal(totals(month).lowest, -10000);
  assert.equal(totals(month).ending, 40000);
});
test('compact schedule accounts for every item exactly once', () => {
  const month = fixture();
  const rows = compactSchedule(month);
  const reconstructed = rows.filter(row => ['opening', 'pay', 'expense'].includes(row.kind)).reduce((sum, row) => sum + row.amountCents, 0);
  assert.equal(reconstructed, totals(month).ending);
  assert.equal(nextMonth('2026-12'), '2027-01');
});
test('document validation rejects out-of-month debit days and duplicate IDs', () => {
  const month = fixture();
  assert.equal(validateDocument(month), month);
  month.bills[0].day = 31;
  assert.throws(() => validateDocument(month));
  month.bills[0].day = 10;
  month.charges.push({ ...month.charges[0] });
  assert.throws(() => validateDocument(month));
});
