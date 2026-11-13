import { copy, validMonth, validateDocument } from './budget.js';

export class ConflictError extends Error {
  constructor() {
    super('This budget changed on another device. Reload the saved version before editing again.');
    this.name = 'ConflictError';
  }
}

function databaseError(error) {
  if (error.code === '40001' || error.code === '23505') return new ConflictError();
  return new Error(error.message || 'Could not save your budget.');
}

export function createLocalRepository(storage = globalThis.localStorage) {
  const prefix = 'm-app:v1:';
  const monthPrefix = prefix + 'month:';

  function read(key) {
    const value = storage.getItem(prefix + key);
    return value ? JSON.parse(value) : null;
  }

  function write(key, document, expectedRevision) {
    const existing = read(key);
    if ((existing?.revision ?? 0) !== expectedRevision) throw new ConflictError();
    const record = { document: copy(document), revision: expectedRevision + 1, updatedAt: new Date().toISOString() };
    storage.setItem(prefix + key, JSON.stringify(record));
    return record;
  }

  return {
    mode: 'local',
    async loadMonth(month) { return read('month:' + month); },
    async loadPreviousMonth(month) {
      let latest = '';
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(monthPrefix)) continue;
        const candidate = key.slice(monthPrefix.length);
        if (validMonth(candidate) && candidate < month && candidate > latest) latest = candidate;
      }
      return latest ? read('month:' + latest) : null;
    },
    async saveMonth(document, revision) {
      validateDocument(document);
      return write('month:' + document.month, document, revision);
    },
    async loadPreferences() { return read('preferences'); },
    async savePreferences(document, revision) { return write('preferences', document, revision); },
  };
}

export function createCloudRepository(client) {
  async function load(query) {
    const { data, error } = await query.maybeSingle();
    if (error) throw databaseError(error);
    return data ? { document: data.document, revision: data.revision, updatedAt: data.updated_at } : null;
  }

  async function save(rpc, document, revision, month) {
    const args = { p_document: document, p_expected_revision: revision };
    if (month) args.p_month = month + '-01';
    const { data, error } = await client.rpc(rpc, args);
    if (error) throw databaseError(error);
    const record = Array.isArray(data) ? data[0] : data;
    if (!record) throw new Error('The database did not confirm the save.');
    return { document: record.document, revision: record.revision, updatedAt: record.updated_at };
  }

  const monthRecords = () => client.from('m_app_months').select('document, revision, updated_at');
  return {
    mode: 'cloud',
    loadMonth: month => load(monthRecords().eq('month', month + '-01')),
    loadPreviousMonth: month => load(monthRecords().lt('month', month + '-01').order('month', { ascending: false }).limit(1)),
    saveMonth(document, revision) {
      validateDocument(document);
      return save('m_app_save_month', document, revision, document.month);
    },
    loadPreferences: () => load(client.from('m_app_preferences').select('document, revision, updated_at')),
    savePreferences: (document, revision) => save('m_app_save_preferences', document, revision),
  };
}
