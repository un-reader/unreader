import pkg from 'pg';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, readdir, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';

import { schema, backfill } from './database-schema.js';

const { Pool } = pkg;
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const unavailable = (error) => /^(08|53|57P0)/.test(error.code || '') ||
  ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(error.code) ||
  /connection|timeout|quota|limit exceeded|compute.*suspend/i.test(error.message || '');

async function saveFile(path, value) {
  const temporary = path + '.tmp';
  const file = await open(temporary, 'w', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(resolve(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function fingerprint(rows) {
  let sum = 0n;
  for (const row of rows) sum += BigInt('0x' + createHash('sha256').update(row).digest('hex'));
  return sum;
}

async function snapshotTable(client, table, visit) {
  await client.query(`DECLARE unreader_snapshot NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS data FROM ${quote(table.name)} t;`);
  const batchSize = ['wikipedia', 'profile_images'].includes(table.name) ? 5 : 2000;
  let count = 0;
  let hash = 0n;
  while (true) {
    const batch = await client.query(`FETCH FORWARD ${batchSize} FROM unreader_snapshot;`);
    const rows = batch.rows.map((row) => row.data);
    count += rows.length;
    hash += fingerprint(rows);
    await visit(rows);
    if (batch.rowCount < batchSize) break;
  }
  await client.query('CLOSE unreader_snapshot;');
  return { count, hash: hash.toString(16) };
}

function createRemoteDatabase(url, secret) {
  if (!secret) throw new Error('DB_COORDINATOR_SECRET is required for remote database access.');
  const endpoint = new URL('/internal/database', url);
  if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname))
    throw new Error('DB_COORDINATOR_URL must use HTTPS outside localhost.');
  async function request(action, args = {}) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ action, ...args }),
      signal: AbortSignal.timeout(120000),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Database coordinator unavailable.'), { code: result.code });
    return result;
  }
  return {
    initialize: () => request('ready'),
    query: (text, values) => request('query', { text, values }),
    async connect() {
      const { session } = await request('connect');
      return {
        query: (text, values) => request('query', { session, text, values }),
        release: () => request('release', { session }).catch(() => {}),
      };
    },
    end: async () => {},
  };
}

export function createDatabase({ env = process.env, log = console.log, createPool = (options) => new Pool(options) } = {}) {
  if (env.DB_COORDINATOR_URL)
    return createRemoteDatabase(env.DB_COORDINATOR_URL, env.DB_COORDINATOR_SECRET);
  const poolOptions = {
    max: Number(env.DB_POOL_MAX || 20),
    min: Number(env.DB_POOL_MIN || 0),
    idleTimeoutMillis: Number(env.DB_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(env.DB_CONNECTION_TIMEOUT_MS || 15000),
    query_timeout: Number(env.DB_QUERY_TIMEOUT_MS || 35000),
    maxUses: Number(env.DB_MAX_USES || 0) || undefined,
  };
  const providers = [
    ['neon', env.NEON_DB_URL],
    ['layerbase', env.LB_DB_URL],
  ].filter(([, url]) => url).map(([name, connectionString]) => {
    const pool = createPool({ ...poolOptions, connectionString });
    pool.on('error', (error) => log(`${name} pool error:`, error.code || 'connection unavailable'));
    return { name, pool, retryAfter: 0 };
  });
  if (!providers.length) {
    const pool = new Pool({ ...poolOptions, connectionString: 'postgresql://postgres:postgres@localhost:5432/unreader' });
    pool.on('error', (error) => log('PostgreSQL pool error:', error.code || 'connection unavailable'));
    return { query: (...args) => pool.query(...args), connect: () => pool.connect(), initialize: () => pool.query(schema + backfill), end: () => pool.end() };
  }
  if (providers.length === 1) {
    const { pool } = providers[0];
    return { query: (...args) => pool.query(...args), connect: () => pool.connect(), initialize: () => pool.query(schema + backfill), end: () => pool.end() };
  }
  if (!env.DB_REPLICA_DIR)
    throw new Error('Dual-database mode requires DB_REPLICA_DIR on persistent disk, or DB_COORDINATOR_URL for serverless deployments.');
  if (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY)
    throw new Error('Serverless dual-database deployments must use DB_COORDINATOR_URL.');

  const directory = resolve(env.DB_REPLICA_DIR);
  const retryMs = Math.max(1000, Number(env.DB_RETRY_MS || 30000));
  const records = new Map();
  const sessions = new Map();
  let state;
  let tables;
  let sequenceNames;
  let active;
  let ready;
  let timer;
  let lock;
  let queue = Promise.resolve();
  let closed = false;
  let maintenancePending = false;

  async function acquire() {
    const previous = queue;
    let unlock;
    queue = new Promise((resolve) => { unlock = resolve; });
    await previous;
    return unlock;
  }

  function failed(provider, error) {
    provider.retryAfter = Date.now() + retryMs;
    log(`${provider.name} unavailable; recovery will retry:`, error.code || 'replication error', error.message);
  }

  async function metadata(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _unreader_replica (
        singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
        group_id TEXT NOT NULL, applied BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _unreader_changes (
        ordinal BIGSERIAL PRIMARY KEY, operation TEXT NOT NULL,
        table_name TEXT NOT NULL, before_row JSONB, after_row JSONB
      );
      CREATE OR REPLACE FUNCTION _unreader_capture() RETURNS trigger AS $$
      DECLARE operation_id TEXT := current_setting('unreader.operation', true);
      BEGIN
        IF operation_id IS NOT NULL AND operation_id <> '' THEN
          INSERT INTO _unreader_changes (operation, table_name, before_row, after_row)
          VALUES (operation_id, TG_TABLE_NAME,
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
  }

  async function installTriggers(client, definitions = tables) {
    await client.query(definitions.map((table) => {
      const name = quote(table.name);
      return `DROP TRIGGER IF EXISTS _unreader_capture ON ${name};
        CREATE TRIGGER _unreader_capture AFTER INSERT OR UPDATE OR DELETE ON ${name}
        FOR EACH ROW EXECUTE FUNCTION _unreader_capture();`;
    }).join('\n'));
  }

  async function readTables(client) {
    const result = await client.query(`
      SELECT c.relname AS name,
        (SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
          'notNull', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid)) ORDER BY a.attnum)
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
        COALESCE((SELECT json_agg(a.attname ORDER BY k.ordinality)
          FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ordinality)
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
          WHERE i.indrelid = c.oid AND i.indisprimary), '[]') AS keys
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE '\\_unreader\\_%'
      ORDER BY c.relname;
    `);
    const dependencies = await client.query(`SELECT child.relname AS child, parent.relname AS parent
      FROM pg_constraint con JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_class parent ON parent.oid = con.confrelid
      WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace;`);
    const sorted = [];
    const remaining = [...result.rows];
    while (remaining.length) {
      const index = remaining.findIndex((table) => !dependencies.rows.some((dep) =>
        dep.child === table.name && dep.parent !== table.name && remaining.some((other) => other.name === dep.parent)));
      if (index < 0) throw new Error('Circular foreign keys require a custom bootstrap migration.');
      sorted.push(...remaining.splice(index, 1));
    }
    return sorted;
  }

  async function alignReplicaColumns(client) {
    for (const table of state.tables) {
      if (!table.columns) throw new Error('Source column metadata is required before initializing the replica.');
      const name = quote(table.name);
      const existing = await client.query(`SELECT 1 FROM ${name} LIMIT 1;`);
      if (existing.rowCount) throw new Error('Initial replica must be empty. No existing data was overwritten.');
      const columns = await client.query(`SELECT attname AS name, format_type(atttypid, atttypmod) AS type
        FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped;`, [name]);
      const statements = [];
      for (const column of table.columns) {
        const target = columns.rows.find((entry) => entry.name === column.name);
        const prefix = `ALTER TABLE ${name}`;
        if (!target) statements.push(`${prefix} ADD COLUMN ${quote(column.name)} ${column.type}${column.default ? ' DEFAULT ' + column.default : ''};`);
        else if (target.type !== column.type) statements.push(`${prefix} ALTER COLUMN ${quote(column.name)} TYPE ${column.type};`);
        statements.push(`${prefix} ALTER COLUMN ${quote(column.name)} ${column.notNull ? 'SET' : 'DROP'} NOT NULL;`);
      }
      if (statements.length) await client.query(statements.join('\n'));
    }
  }

  async function readSequences(client) {
    if (!sequenceNames) {
      const result = await client.query(`SELECT pg_get_serial_sequence(
        quote_ident(table_schema) || '.' || quote_ident(table_name), column_name) AS name
        FROM information_schema.columns WHERE table_schema = 'public'
        AND table_name NOT LIKE '\\_unreader\\_%' AND column_default LIKE 'nextval(%';`);
      sequenceNames = result.rows.map((row) => row.name);
    }
    if (!sequenceNames.length) return [];
    const result = await client.query(sequenceNames.map((name) =>
      `SELECT '${name.replaceAll("'", "''")}' AS name, last_value::text, is_called FROM ${name}`
    ).join(' UNION ALL '));
    return result.rows;
  }

  async function restoreSequences(client, sequences) {
    if (!sequences.length) return;
    await client.query(sequences.map(({ name, last_value, is_called }) => {
      if (!/^\d+$/.test(last_value)) throw new Error('Invalid sequence position in recovery journal.');
      return `SELECT setval('${name.replaceAll("'", "''")}', ${last_value}, ${is_called ? 'true' : 'false'});`;
    }).join('\n'));
  }

  async function acceptBaseline(client, record) {
    await client.query(`LOCK TABLE ${tables.map((table) => quote(table.name)).join(', ')} IN SHARE MODE;`);
    let populated = false;
    for (const table of tables) {
      const result = await client.query(`SELECT 1 FROM ${quote(table.name)} LIMIT 1;`);
      if (result.rowCount) { populated = true; break; }
    }
    if (!populated) return false;
    for (const table of tables) {
      const actual = await snapshotTable(client, table, async () => {});
      const expected = record.snapshot[table.name];
      if (!expected || actual.count !== expected.count || actual.hash !== expected.hash)
        throw new Error('Database differs from the initial baseline. Restore the same backup before joining replication; existing data was not overwritten.');
    }
    await restoreSequences(client, record.sequences);
    await client.query(`INSERT INTO _unreader_replica (group_id, applied) VALUES ($1, $2)
      ON CONFLICT (singleton) DO UPDATE SET group_id = EXCLUDED.group_id, applied = EXCLUDED.applied;`, [state.group, record.sequence]);
    return true;
  }

  async function apply(client, record) {
    const result = await client.query('SELECT group_id, applied FROM _unreader_replica WHERE singleton FOR UPDATE;');
    const current = result.rows[0];
    if (current && current.group_id !== state.group)
      throw new Error('Database belongs to another recovery journal. Restore its original DB_REPLICA_DIR.');
    const applied = Number(current?.applied || 0);
    if (applied >= record.sequence) return;
    if (applied !== record.sequence - 1)
      throw new Error('Recovery journal has a gap; refusing to serve stale data.');
    if (record.snapshot) {
      for (const table of tables) {
        const existing = await client.query(`SELECT 1 FROM ${quote(table.name)} LIMIT 1;`);
        if (existing.rowCount) throw new Error('Initial replica must be empty. No existing data was overwritten.');
      }
      for (const table of tables) {
        const snapshot = record.snapshot[table.name];
        let count = 0;
        let hash = 0n;
        for (const chunk of snapshot.chunks) {
          const rows = JSON.parse(await readFile(join(directory, chunk), 'utf8'));
          count += rows.length;
          hash += fingerprint(rows);
          if (rows.length) await client.query(`INSERT INTO ${quote(table.name)} SELECT * FROM jsonb_populate_recordset(NULL::${quote(table.name)}, $1::jsonb);`, ['[' + rows.join(',') + ']']);
        }
        if (count !== snapshot.count || hash.toString(16) !== snapshot.hash)
          throw new Error('Baseline chunk verification failed. Restore the recovery journal.');
      }
    } else {
      for (const change of record.changes) {
        const table = tables.find((entry) => entry.name === change.table_name);
        if (!table) throw new Error('Recovery record references an unknown table.');
        const name = quote(table.name);
        if (!change.before_row) {
          await client.query(`INSERT INTO ${name} SELECT * FROM jsonb_populate_record(NULL::${name}, $1::jsonb);`, [change.after_row]);
        } else {
          const before = JSON.parse(change.before_row);
          const columns = table.keys.length ? table.keys : Object.keys(before);
          const match = columns.map((column) => `t.${quote(column)} IS NOT DISTINCT FROM old.${quote(column)}`).join(' AND ');
          if (!change.after_row) {
            await client.query(`DELETE FROM ${name} WHERE ctid = (SELECT t.ctid FROM ${name} t,
              jsonb_populate_record(NULL::${name}, $1::jsonb) old WHERE ${match} LIMIT 1);`, [change.before_row]);
          } else {
            const columns = Object.keys(JSON.parse(change.after_row));
            const updated = await client.query(`UPDATE ${name} SET (${columns.map(quote).join(', ')}) =
              (SELECT ${columns.map(quote).join(', ')} FROM jsonb_populate_record(NULL::${name}, $2::jsonb))
              WHERE ctid = (SELECT t.ctid FROM ${name} t,
                jsonb_populate_record(NULL::${name}, $1::jsonb) old WHERE ${match} LIMIT 1);`, [change.before_row, change.after_row]);
            if (updated.rowCount !== 1) throw new Error('Replica row is missing; refusing to advance its checkpoint.');
          }
        }
      }
    }
    await restoreSequences(client, record.sequences);
    await client.query(`INSERT INTO _unreader_replica (group_id, applied) VALUES ($1, $2)
      ON CONFLICT (singleton) DO UPDATE SET applied = EXCLUDED.applied;`, [state.group, record.sequence]);
  }

  async function catchUp(provider) {
    if (provider.applied === state.sequence && provider.retryAfter === 0) return true;
    if (provider.retryAfter > Date.now()) return false;
    let client;
    try {
      client = await provider.pool.connect();
      if (!provider.prepared) {
        await client.query(schema);
        await metadata(client);
        await installTriggers(client);
        provider.prepared = true;
      }
      await client.query('BEGIN');
      const result = await client.query('SELECT group_id, applied FROM _unreader_replica WHERE singleton;');
      let current = result.rows[0];
      const baseline = records.get(1);
      if ((!current || current.group_id !== state.group) && baseline?.snapshot) {
        if (await acceptBaseline(client, baseline)) {
          current = { group_id: state.group, applied: baseline.sequence };
        } else {
          await alignReplicaColumns(client);
          await client.query('DELETE FROM _unreader_replica WHERE singleton;');
          current = null;
        }
      }
      if (current && current.group_id !== state.group) throw new Error('Recovery journal does not match this database.');
      let applied = Number(current?.applied || 0);
      if (applied > state.sequence) throw new Error('Recovery journal is older than the database.');
      for (let sequence = applied + 1; sequence <= state.sequence; sequence++) {
        const record = records.get(sequence);
        if (!record) throw new Error('Recovery journal is missing required writes.');
        await apply(client, record);
        applied = sequence;
      }
      await client.query('COMMIT');
      provider.retryAfter = 0;
      provider.applied = applied;
      return true;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      failed(provider, error);
      return false;
    } finally { if (client) client.release(); }
  }

  async function selectProvider() {
    const candidates = active ? [active, ...providers.filter((provider) => provider !== active)] : providers;
    for (const provider of candidates) {
      if (await catchUp(provider)) {
        if (active !== provider) {
          log(`Using database: ${provider.name}`);
          state.active = provider.name;
          await saveFile(join(directory, 'state.json'), state);
        }
        active = provider;
        return provider;
      }
    }
    throw Object.assign(new Error('Neither database can safely serve current data. Recovery will retry.'), { code: '08006' });
  }

  async function recordWrite(client, operation) {
    const result = await client.query(`SELECT table_name, before_row::text, after_row::text
      FROM _unreader_changes WHERE operation = $1 ORDER BY ordinal;`, [operation]);
    if (!result.rowCount) return false;
    const record = { sequence: state.sequence + 1, changes: result.rows, sequences: await readSequences(client) };
    await saveFile(join(directory, `${record.sequence}.json`), record);
    records.set(record.sequence, record);
    state.sequence = record.sequence;
    await saveFile(join(directory, 'state.json'), state);
    await client.query('UPDATE _unreader_replica SET applied = $1 WHERE singleton;', [record.sequence]);
    await client.query('DELETE FROM _unreader_changes WHERE operation = $1;', [operation]);
    return true;
  }

  async function synchronize() {
    for (const provider of providers) await catchUp(provider);
    const applied = Math.min(...providers.map((provider) => provider.applied || 0));
    for (const sequence of records.keys()) {
      if (sequence <= applied) {
        const record = records.get(sequence);
        await unlink(join(directory, `${sequence}.json`));
        records.delete(sequence);
        if (record.snapshot) {
          for (const table of Object.values(record.snapshot)) {
            for (const chunk of table.chunks) await unlink(join(directory, chunk)).catch((error) => {
              if (error.code !== 'ENOENT') throw error;
            });
          }
        }
      }
    }
  }

  async function initialize() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      lock = await open(join(directory, 'coordinator.lock'), 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(join(directory, 'coordinator.lock'), 'utf8'));
      try { process.kill(pid, 0); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        await unlink(join(directory, 'coordinator.lock'));
        lock = await open(join(directory, 'coordinator.lock'), 'wx', 0o600);
      }
      if (!lock) throw new Error('Another coordinator owns DB_REPLICA_DIR.');
    }
    await lock.writeFile(String(process.pid));
    try { state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of await readdir(directory)) {
      if (!/^\d+\.json$/.test(file)) continue;
      const record = JSON.parse(await readFile(join(directory, file), 'utf8'));
      records.set(record.sequence, record);
    }
    if (state) state.sequence = Math.max(state.sequence, ...records.keys());
    const prepared = await Promise.all(providers.map(async (provider) => {
      let client;
      try {
        log(`Preparing ${provider.name} replication schema...`);
        client = await provider.pool.connect();
        await client.query(schema);
        await metadata(client);
        const definitions = await readTables(client);
        await installTriggers(client, definitions);
        provider.prepared = true;
        const checkpoint = await client.query('SELECT group_id, applied FROM _unreader_replica WHERE singleton;');
        const populated = await client.query(`SELECT ${definitions.map((table) =>
          `EXISTS (SELECT 1 FROM ${quote(table.name)} LIMIT 1)`
        ).join(' OR ')} AS populated;`);
        return { provider, definitions, checkpoint: checkpoint.rows[0], populated: populated.rows[0].populated };
      } catch (error) {
        if (!unavailable(error)) throw error;
        failed(provider, error);
        return null;
      } finally { if (client) client.release(); }
    }));
    const available = prepared.filter(Boolean);
    if (!available.length) throw new Error('Could not initialize database recovery: neither database is available.');
    if (!state) {
      const group = available[0].checkpoint?.group_id;
      const sameGroup = group && available.every((entry) => entry.checkpoint?.group_id === group);
      const highest = sameGroup ? Math.max(...available.map((entry) => Number(entry.checkpoint.applied))) : null;
      const current = available.filter((entry) => highest === null || Number(entry.checkpoint?.applied || 0) === highest);
      const populated = current.filter((entry) => entry.populated);
      const candidates = populated.length ? populated : current;
      const source = candidates[Math.floor(Math.random() * candidates.length)];
      tables = source.definitions;
      const client = await source.provider.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query(`LOCK TABLE ${tables.map((table) => quote(table.name)).join(', ')} IN SHARE MODE;`);
        log(`Saving the initial ${source.provider.name} baseline...`);
        const snapshot = {};
        for (const [tableIndex, table] of tables.entries()) {
          const chunks = [];
          const digest = await snapshotTable(client, table, async (rows) => {
            if (!rows.length) return;
            const file = `baseline-${tableIndex}-${chunks.length}.json`;
            await saveFile(join(directory, file), rows);
            chunks.push(file);
          });
          snapshot[table.name] = { chunks, ...digest };
          log(`Baseline: ${table.name}, ${digest.count} rows`);
        }
        state = { group: randomUUID(), sequence: 1, tables, active: source.provider.name };
        const record = { sequence: 1, snapshot, sequences: await readSequences(client) };
        await saveFile(join(directory, '1.json'), record);
        records.set(1, record);
        await saveFile(join(directory, 'state.json'), state);
        await client.query(`INSERT INTO _unreader_replica (group_id, applied) VALUES ($1, 1)
          ON CONFLICT (singleton) DO UPDATE SET group_id = EXCLUDED.group_id, applied = EXCLUDED.applied;`, [state.group]);
        await client.query('COMMIT');
        source.provider.applied = 1;
        active = source.provider;
        log(`${source.provider.name} baseline saved to the durable recovery journal.`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    } else {
      if (state.tables.some((table) => !table.columns)) {
        const source = available.find((entry) => entry.checkpoint?.group_id === state.group);
        if (!source) throw new Error('No available database matches the recovery journal.');
        state.tables = source.definitions;
        await saveFile(join(directory, 'state.json'), state);
      }
      active = providers.find((provider) => provider.name === state.active);
      if (!active) {
        const matching = available.filter((entry) => entry.checkpoint?.group_id === state.group);
        matching.sort((a, b) => Number(b.checkpoint.applied) - Number(a.checkpoint.applied));
        const latest = matching.filter((entry) => entry.checkpoint.applied === matching[0]?.checkpoint.applied);
        active = latest[Math.floor(Math.random() * latest.length)]?.provider;
        if (active) {
          state.active = active.name;
          await saveFile(join(directory, 'state.json'), state);
        }
      }
    }
    tables = state.tables;
    const provider = await selectProvider();
    const client = await provider.pool.connect();
    try {
      await client.query('BEGIN');
      const operation = randomUUID();
      await client.query("SELECT set_config('unreader.operation', $1, true);", [operation]);
      await client.query(backfill);
      await recordWrite(client, operation);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    await synchronize();
    timer = setInterval(async () => {
      if (maintenancePending || closed) return;
      maintenancePending = true;
      const unlock = await acquire();
      try { if (!closed) await synchronize(); }
      catch (error) { log('Database recovery failed:', error.message); }
      finally { maintenancePending = false; unlock(); }
    }, retryMs);
    timer.unref();
  }

  async function connect() {
    await ready;
    const unlock = await acquire();
    let client;
    let provider;
    let operation;
    let inTransaction = false;
    let released = false;
    let journaled = false;
    let preparingCommit = false;
    let broken = false;
    try {
      for (let attempt = 0; attempt < providers.length; attempt++) {
        provider = await selectProvider();
        try { client = await provider.pool.connect(); break; }
        catch (error) {
          if (!unavailable(error)) throw error;
          failed(provider, error);
          if (attempt === providers.length - 1) throw error;
        }
      }
    } catch (error) { unlock(); throw error; }
    return {
      get canRetry() { return !preparingCommit; },
      async query(text, values) {
        if (released) throw new Error('Database client already released.');
        const command = text.trim().replace(/;$/, '').toUpperCase();
        if (broken && command === 'ROLLBACK') return { rows: [], rowCount: null, command: 'ROLLBACK' };
        if (broken) throw Object.assign(new Error('Database connection is unavailable.'), { code: '08006' });
        try {
          if (command === 'BEGIN') {
            await client.query('BEGIN');
            operation = randomUUID();
            await client.query("SELECT set_config('unreader.operation', $1, true);", [operation]);
            inTransaction = true;
            return { rows: [], rowCount: null, command: 'BEGIN' };
          }
          if (command === 'COMMIT') {
            preparingCommit = true;
            journaled = await recordWrite(client, operation);
            try {
              const result = await client.query('COMMIT');
              inTransaction = false;
              provider.applied = state.sequence;
              return result;
            } catch (error) {
              if (!journaled || !unavailable(error)) throw error;
              failed(provider, error);
              client.release(true);
              client = null;
              inTransaction = false;
              await selectProvider();
              return { rows: [], rowCount: null, command: 'COMMIT' };
            }
          }
          if (command === 'ROLLBACK') {
            const result = await client.query('ROLLBACK');
            inTransaction = false;
            return result;
          }
          if (!inTransaction) throw new Error('Use BEGIN before querying a checked-out replica client.');
          return await client.query(text, values);
        } catch (error) {
          if (unavailable(error)) broken = true;
          if (broken || journaled) failed(provider, error);
          throw error;
        }
      },
      async release() {
        if (released) return;
        released = true;
        try {
          if (inTransaction && client && !broken) await client.query('ROLLBACK').catch(() => {});
          if (client) client.release(broken);
          if (journaled) await synchronize();
        } finally { unlock(); }
      },
    };
  }

  return {
    initialize() { return ready ||= initialize(); },
    async query(text, values) {
      await ready;
      if (/^\s*SELECT\b/i.test(text)) {
        const unlock = await acquire();
        try {
          for (let attempt = 0; attempt < providers.length; attempt++) {
            const provider = await selectProvider();
            try { return await provider.pool.query(text, values); }
            catch (error) { if (!unavailable(error)) throw error; failed(provider, error); }
          }
          throw new Error('Both databases are unavailable.');
        } finally { unlock(); }
      }
      for (let attempt = 0; attempt < providers.length; attempt++) {
        const client = await connect();
        try {
          await client.query('BEGIN');
          const result = await client.query(text, values);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          if (!unavailable(error) || !client.canRetry || attempt === providers.length - 1) throw error;
        } finally { await client.release(); }
      }
    },
    connect,
    status() { return { active: active?.name, sequence: state?.sequence, pending: records.size, providers: providers.map(({ name, applied, retryAfter }) => ({ name, applied, available: retryAfter <= Date.now() })) }; },
    async rpc(body) {
      await ready;
      if (body.action === 'ready') return { ready: true };
      if (body.action === 'connect') {
        const client = await connect();
        const session = randomUUID();
        const timeout = setTimeout(() => { sessions.delete(session); client.release().catch(() => {}); }, 60000);
        timeout.unref();
        sessions.set(session, { client, timeout });
        return { session };
      }
      if (body.session) {
        const session = sessions.get(body.session);
        if (!session) throw new Error('Database session expired.');
        if (body.action === 'release') {
          sessions.delete(body.session);
          clearTimeout(session.timeout);
          await session.client.release();
          return { released: true };
        }
        if (body.action === 'query') return session.client.query(body.text, body.values);
      }
      if (body.action === 'query') return this.query(body.text, body.values);
      throw new Error('Unknown database coordinator action.');
    },
    async end() {
      closed = true;
      clearInterval(timer);
      for (const session of sessions.values()) { clearTimeout(session.timeout); await session.client.release(); }
      const unlock = await acquire();
      try {
        await Promise.all(providers.map(({ pool }) => pool.end()));
        if (lock) { await lock.close(); await unlink(join(directory, 'coordinator.lock')); }
      } finally { unlock(); }
    },
  };
}

export function coordinatorAuthorized(header, secret) {
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
