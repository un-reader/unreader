import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import pkg from 'pg';
import { createDatabase, coordinatorAuthorized } from '../database.js';
import { schema } from '../database-schema.js';

const { Pool } = pkg;
const enabled = process.env.TEST_NEON_DB_URL && process.env.TEST_LB_DB_URL;

test('coordinator authentication rejects missing and incorrect secrets', () => {
  assert.equal(coordinatorAuthorized(undefined, 'secret'), false);
  assert.equal(coordinatorAuthorized('Bearer incorrect', 'secret'), false);
  assert.equal(coordinatorAuthorized('Bearer secret', 'secret'), true);
  assert.equal(coordinatorAuthorized('Bearer ', ''), false);
});

test('serverless dual database access requires a shared coordinator', () => {
  assert.throws(() => createDatabase({ env: {
    NEON_DB_URL: 'postgres://localhost/one', LB_DB_URL: 'postgres://localhost/two',
    VERCEL: '1', DB_REPLICA_DIR: '/tmp/unsafe',
  } }), /Serverless/);
});

test('real PostgreSQL bootstrap, failover, recovery, restart and serverless transactions', { skip: !enabled, timeout: 600000 }, async (t) => {
  const name = 'unreader_replica_test_' + randomBytes(6).toString('hex');
  console.log('Temporary test databases:', name);
  const directory = await mkdtemp(join(tmpdir(), 'unreader-replica-'));
  const roots = [process.env.TEST_NEON_DB_URL, process.env.TEST_LB_DB_URL];
  const admins = roots.map((connectionString) => new Pool({ connectionString, connectionTimeoutMillis: 30000 }));
  const urls = roots.map((connectionString, index) => { const url = new URL(connectionString); url.pathname = '/' + name + '_' + index; return url.href; });
  const checks = urls.map((connectionString) => new Pool({ connectionString, connectionTimeoutMillis: 30000 }));
  const down = [false, false];
  let loseCommit = false;
  let db;
  let server;
  const env = { NEON_DB_URL: urls[0], LB_DB_URL: urls[1], DB_REPLICA_DIR: directory, DB_RETRY_MS: '1000', DB_CONNECTION_TIMEOUT_MS: '30000' };
  function createPool(options) {
    const index = urls.indexOf(options.connectionString);
    const pool = new Pool(options);
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      if (down[index]) throw Object.assign(new Error('Simulated provider quota exhausted'), { code: '53300' });
      const client = await connect();
      const query = client.query.bind(client);
      const release = client.release.bind(client);
      let changed = false;
      client.query = async (...args) => {
        if (down[index]) throw Object.assign(new Error('Simulated connection lost'), { code: 'ECONNRESET' });
        if (/^BEGIN\b/.test(args[0])) changed = false;
        if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(args[0])) changed = true;
        const result = await query(...args);
        if (loseCommit && changed && args[0] === 'COMMIT') {
          loseCommit = false;
          down[index] = true;
          throw Object.assign(new Error('Simulated lost COMMIT acknowledgement'), { code: 'ECONNRESET' });
        }
        return result;
      };
      client.release = (...args) => { client.query = query; client.release = release; return release(...args); };
      return client;
    };
    // pg's pool.query uses its callback connect signature; route test reads through a checked-out client.
    pool.query = async (...args) => {
      const client = await pool.connect();
      try { return await client.query(...args); } finally { client.release(); }
    };
    return pool;
  }
  const makeDatabase = () => createDatabase({ env, createPool, log: (...args) => console.log(...args) });
  async function recovered() {
    const deadline = Date.now() + 60000;
    while (db.status().pending) {
      assert.ok(Date.now() < deadline, 'Both providers should recover within one minute.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  async function equalRows(table) {
    const results = await Promise.all(checks.map((pool) => pool.query(`SELECT to_jsonb(t)::text AS data FROM "${table}" t ORDER BY to_jsonb(t)::text;`)));
    assert.deepEqual(results[0].rows, results[1].rows, table + ' converges');
  }
  try {
    for (const [index, admin] of admins.entries()) await admin.query(`CREATE DATABASE ${name}_${index};`);
    await checks[0].query(schema);
    await checks[0].query("INSERT INTO users (username, password_hash, timeout_until) VALUES ('replica_seed', 'test', 9007199254740993); INSERT INTO profiles (username, bio) VALUES ('replica_seed', 'seed profile');");
    await checks[0].query("ALTER TABLE roles ALTER COLUMN class DROP NOT NULL; INSERT INTO roles (role, prefix, style, class) VALUES ('legacy_role', '', '', NULL);");
    db = makeDatabase();
    await db.initialize();
    await equalRows('users');
    await equalRows('profiles');
    await equalRows('roles');
    assert.equal((await db.query("SELECT timeout_until FROM users WHERE username = 'replica_seed';")).rows[0].timeout_until, '9007199254740993');
    t.diagnostic('Bootstrap copied the existing Neon database into the empty replica.');

    await db.query("INSERT INTO messages (username, timestamp, content) VALUES ('replica_seed', 'now', 'first') RETURNING id;");
    await equalRows('messages');
    await assert.rejects(db.query("INSERT INTO users (username, password_hash) VALUES ('replica_seed', 'duplicate');"), { code: '23505' });

    down[0] = true;
    const inserted = await db.query("INSERT INTO messages (username, timestamp, content) VALUES ('replica_seed', 'now', 'during Neon outage') RETURNING id;");
    assert.equal(db.status().active, 'layerbase');
    await db.query('UPDATE messages SET content = $1 WHERE id = $2;', ['edited during outage', inserted.rows[0].id]);
    await db.query("INSERT INTO pets VALUES ('duplicate', 'replica_seed', '{}', '2026-10-28'), ('duplicate', 'replica_seed', '{}', '2026-10-28');");
    await db.query("DELETE FROM pets WHERE ctid = (SELECT ctid FROM pets LIMIT 1);");
    await db.end();
    db = makeDatabase();
    await db.initialize();
    assert.equal((await db.query('SELECT content FROM messages WHERE id = $1;', [inserted.rows[0].id])).rows[0].content, 'edited during outage');
    down[0] = false;
    await recovered();
    await equalRows('messages');
    await equalRows('pets');
    t.diagnostic('Neon outage, durable restart and recovery preserved inserts, updates and duplicate keyless rows.');

    down[1] = true;
    await db.query("DELETE FROM messages WHERE content = 'first';");
    assert.equal(db.status().active, 'neon');
    down[1] = false;
    await recovered();
    await equalRows('messages');

    const transaction = await db.connect();
    await transaction.query('BEGIN');
    await transaction.query("INSERT INTO messages (username, timestamp, content) VALUES ('replica_seed', 'now', 'rolled back');");
    await transaction.query('ROLLBACK');
    await transaction.release();
    assert.equal((await db.query("SELECT * FROM messages WHERE content = 'rolled back';")).rowCount, 0);
    await equalRows('messages');

    await db.query('DELETE FROM messages WHERE id = $1;', [inserted.rows[0].id]);
    down[0] = true;
    const next = await db.query("INSERT INTO messages (username, timestamp, content) VALUES ('replica_seed', 'now', 'after deleting highest ID') RETURNING id;");
    assert.ok(next.rows[0].id > inserted.rows[0].id);
    down.fill(false);
    await recovered();
    await equalRows('messages');

    loseCommit = true;
    await db.query("INSERT INTO messages (username, timestamp, content) VALUES ('replica_seed', 'now', 'commit acknowledgement lost');");
    assert.equal((await db.query("SELECT * FROM messages WHERE content = 'commit acknowledgement lost';")).rowCount, 1);
    down.fill(false);
    await recovered();
    await equalRows('messages');
    t.diagnostic('Lost COMMIT acknowledgement replayed once without regenerating IDs.');

    server = http.createServer(async (req, res) => {
      if (!coordinatorAuthorized(req.headers.authorization, 'test-secret')) { res.writeHead(404).end(); return; }
      let data = '';
      for await (const chunk of req) data += chunk;
      try { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await db.rpc(JSON.parse(data)))); }
      catch (error) { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message, code: error.code })); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const remote = createDatabase({ env: { DB_COORDINATOR_URL: `http://127.0.0.1:${server.address().port}`, DB_COORDINATOR_SECRET: 'test-secret', VERCEL: '1' } });
    await remote.initialize();
    const client = await remote.connect();
    await client.query('BEGIN');
    await client.query("INSERT INTO users (username, password_hash) VALUES ('remote_user', 'test');");
    await client.query("INSERT INTO profiles (username, bio) VALUES ('remote_user', 'remote transaction');");
    await client.query('COMMIT');
    await client.release();
    await equalRows('users');
    await equalRows('profiles');
    await remote.query("DELETE FROM users WHERE username = 'remote_user';");
    await equalRows('profiles');
    t.diagnostic('Authenticated serverless access preserves multi-statement transactions and cascading deletes.');

    down.fill(true);
    await assert.rejects(db.query('SELECT 1;'));
    t.diagnostic('Both providers unavailable: refused stale reads.');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.end();
    for (const pool of checks) await pool.end();
    for (const [index, admin] of admins.entries()) {
      await admin.query(`DROP DATABASE IF EXISTS ${name}_${index} WITH (FORCE);`).catch((error) => t.diagnostic('Test database cleanup: ' + error.code));
      await admin.end();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('Layerbase restore starts with Neon over quota and joins a restored peer without overwriting data', { skip: !enabled, timeout: 600000 }, async (t) => {
  const name = 'unreader_restore_test_' + randomBytes(6).toString('hex');
  const roots = [process.env.TEST_NEON_DB_URL, process.env.TEST_LB_DB_URL];
  const admins = roots.map((connectionString) => new Pool({ connectionString, connectionTimeoutMillis: 30000 }));
  const urls = roots.map((connectionString, index) => {
    const url = new URL(connectionString);
    url.pathname = `/${name}_${index}`;
    return url.href;
  });
  const checks = urls.map((connectionString) => new Pool({ connectionString, connectionTimeoutMillis: 30000 }));
  const directory = await mkdtemp(join(tmpdir(), 'unreader-restore-'));
  const down = [true, false];
  let db;
  const env = { NEON_DB_URL: urls[0], LB_DB_URL: urls[1], DB_REPLICA_DIR: directory, DB_RETRY_MS: '1000' };
  function createPool(options) {
    const index = urls.indexOf(options.connectionString);
    const pool = new Pool(options);
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      if (down[index]) throw Object.assign(new Error('Your account or project has exceeded the quota.'), { code: '53000' });
      return connect();
    };
    pool.query = async (...args) => {
      const client = await pool.connect();
      try { return await client.query(...args); } finally { client.release(); }
    };
    return pool;
  }
  const messages = [];
  const makeDatabase = () => createDatabase({ env, createPool, log: (...args) => {
    messages.push(args.join(' '));
    t.diagnostic(args.join(' '));
  } });
  async function recovered() {
    const deadline = Date.now() + 60000;
    while (db.status().pending) {
      assert.ok(Date.now() < deadline, 'Restored peer should catch up.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    for (const [index, admin] of admins.entries()) await admin.query(`CREATE DATABASE ${name}_${index};`);
    for (const pool of checks) {
      await pool.query(schema);
      await pool.query(`INSERT INTO users (id, username, password_hash) VALUES (10, 'restored_user', 'backup_hash');
        SELECT setval('users_id_seq', 10);
        CREATE TABLE _unreader_replica (singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), group_id TEXT NOT NULL, applied BIGINT NOT NULL);
        INSERT INTO _unreader_replica VALUES (true, 'metadata-from-manual-backup', 7);`);
    }
    db = makeDatabase();
    await db.initialize();
    assert.equal(db.status().active, 'layerbase');
    assert.equal((await db.query("SELECT username FROM users WHERE id = 10;")).rows[0].username, 'restored_user');
    await db.query("INSERT INTO users (username, password_hash) VALUES ('written_on_layerbase', 'hash');");
    await db.end();
    db = makeDatabase();
    await db.initialize();
    assert.equal(db.status().active, 'layerbase');
    assert.equal((await db.query("SELECT count(*)::int AS count FROM users;")).rows[0].count, 2);
    await checks[0].query("INSERT INTO users (id, username, password_hash) VALUES (90, 'peer_only_row', 'hash');");
    down[0] = false;
    const deadline = Date.now() + 60000;
    while (!messages.some((message) => message.includes('differs from the initial baseline'))) {
      assert.ok(Date.now() < deadline, 'Divergent restored data must be detected.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await checks[0].query("SELECT username FROM users WHERE id = 90;")).rows[0].username, 'peer_only_row');
    assert.equal(db.status().active, 'layerbase');
    await checks[0].query("DELETE FROM users WHERE id = 90;");
    await recovered();
    const users = await Promise.all(checks.map(async (pool) => (await pool.query('SELECT id, username FROM users ORDER BY id;')).rows));
    assert.deepEqual(users[0], users[1]);
    const checkpoints = await Promise.all(checks.map(async (pool) => (await pool.query('SELECT group_id, applied FROM _unreader_replica;')).rows));
    assert.deepEqual(checkpoints[0], checkpoints[1]);
    t.diagnostic('Neon 53000 at first startup: Layerbase restored data served, restart succeeded, and Neon caught up on recovery.');

    await db.end();
    // Keep the recovered provider active when both databases become available again.
    db = makeDatabase();
    await db.initialize();
    assert.equal(db.status().active, 'layerbase');
    down[1] = true;
    assert.equal((await db.query('SELECT count(*)::int AS count FROM users;')).rows[0].count, 2);
    assert.equal(db.status().active, 'neon');
    down[1] = false;
  } finally {
    if (db) await db.end();
    for (const pool of checks) await pool.end();
    for (const [index, admin] of admins.entries()) {
      await admin.query(`DROP DATABASE IF EXISTS ${name}_${index} WITH (FORCE);`).catch((error) => t.diagnostic('Test database cleanup: ' + error.code));
      await admin.end();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
