import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonth } from '../src/budget.js';
import { createLocalRepository, createCloudRepository, ConflictError } from '../src/repository.js';

function memoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}
test('saved months are isolated, persisted, and revisioned', async () => {
  const storage = memoryStorage(), repo = createLocalRepository(storage);
  const november = createMonth('2026-11'), december = createMonth('2026-12');
  november.openingCents = 123456;
  const saved = await repo.saveMonth(november, 0);
  await repo.saveMonth(december, 0);
  november.openingCents = 999;
  assert.equal(saved.revision, 1);
  assert.equal((await repo.loadMonth('2026-11')).document.openingCents, 123456);
  assert.equal((await repo.loadMonth('2026-12')).document.openingCents, 0);
  const secondSession = createLocalRepository(storage);
  assert.equal((await secondSession.loadMonth('2026-11')).revision, 1);
});
test('stale writes cannot silently overwrite another session', async () => {
  const repo = createLocalRepository(memoryStorage()), month = createMonth('2026-11');
  await repo.saveMonth(month, 0);
  await assert.rejects(repo.saveMonth(month, 0), ConflictError);
  await repo.saveMonth(month, 1);
  await assert.rejects(repo.saveMonth(month, 1), ConflictError);
});
test('cloud writes include the chosen month and expected revision', async () => {
  let called;
  const month = createMonth('2026-12');
  const repo = createCloudRepository({ async rpc(name, args) { called = { name, args }; return { data: [{ document: args.p_document, revision: 4, updated_at: 'now' }], error: null }; } });
  const saved = await repo.saveMonth(month, 3);
  assert.equal(called.name, 'm_app_save_month');
  assert.equal(called.args.p_month, '2026-12-01');
  assert.equal(called.args.p_expected_revision, 3);
  assert.equal(saved.revision, 4);
});
test('cloud write conflicts are surfaced, never retried as overwrites', async () => {
  const repo = createCloudRepository({ async rpc() { return { data: null, error: { code: '40001', message: 'conflict' } }; } });
  await assert.rejects(repo.saveMonth(createMonth('2026-11'), 2), ConflictError);
});
