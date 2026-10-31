import express from 'express';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createDatabase, coordinatorAuthorized } from './database.js';
import cors from 'cors';
import sanitizeHtml from 'sanitize-html';
import { pathToFileURL } from 'node:url';

const JWT_SECRET = process.env.JWT_SECRET || 'brutalist_secret_key_123';
const DO_LOGGING = true;

function log(...args) {
  if (DO_LOGGING) console.log(`[SERVER]`, ...args);
}

function sanitize(str, options = {}) {
  if (typeof str !== 'string') return str;
  return sanitizeHtml(str.trim(), {
    allowedTags: options.allowTags
      ? ['b', 'i', 'em', 'strong', 'a', 'p', 'br']
      : [],
    allowedAttributes: options.allowTags ? { a: ['href'] } : {},
    ...options,
  });
}

function sanitizeUsername(username) {
  if (typeof username !== 'string') return username;
  return username.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 32);
}

const db = createDatabase({ log });

const USER_ROLE_CACHE_TTL = Number(process.env.USER_ROLE_CACHE_TTL_MS || 30000);
const userRoleCache = new Map();
const bannedIpCache = new Map();
const BANNED_IP_CACHE_TTL = Number(process.env.BANNED_IP_CACHE_TTL_MS || 30000);
const CHANGELOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CHANGELOG_CACHE_MAX_ENTRIES = 200;
const CHANGELOG_LATEST_PAGE_SIZE = 25;
const CHANGELOG_REFRESH_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const changelogCache = new Map();
const changelogRequests = new Map();
const BANNED_IP_DB_RETRY_MS = Math.max(
  1000,
  Number(process.env.BANNED_IP_DB_RETRY_MS) || 10000,
);
let bannedIpDbRetryAfter = 0;

function invalidateUserRoleCache(username = null) {
  if (!username) return userRoleCache.clear();
  userRoleCache.delete(String(username).toLowerCase());
}

function invalidateBannedIpCache(ip = null) {
  if (!ip) return bannedIpCache.clear();
  bannedIpCache.delete(ip);
}

async function initDatabase() {
  try {
    log('Verifying structural integrity...');
    await db.initialize();
    log('Structural migration successful.');
  } catch (err) {
    log('DB MIGRATION FAILURE:', err);
    process.exit(1);
  }
}
const databaseReady = initDatabase();

const app = express();
app.set('trust proxy', true);
app.post('/internal/database', (req, res, next) => {
  if (!db.rpc || !coordinatorAuthorized(req.headers.authorization, process.env.DB_COORDINATOR_SECRET))
    return res.sendStatus(404);
  next();
}, express.json({ limit: '64mb' }), async (req, res) => {
  try {
    res.json(await db.rpc(req.body));
  } catch (error) {
    res.status(503).json({ error: 'Database operation failed.', code: error.code });
  }
});
app.use(async (req, res, next) => {
  try { await databaseReady; next(); }
  catch { res.status(503).json({ error: 'Database is initializing. Please try again.' }); }
});
app.use(cors({ origin: '*' }));
async function blockBannedIPs(req, res, next) {
  const now = Date.now();
  const clientIp = req.ip;
  const cached = bannedIpCache.get(clientIp);
  const cachedBanStatus =
    cached && cached.expiresAt > now ? cached.banned : null;
  if (cachedBanStatus === true)
    return res.status(403).json({ error: 'Yo IP addwess is banned bruh.' });
  if (cachedBanStatus === false || now < bannedIpDbRetryAfter) return next();

  try {
    const check = await db.query('SELECT 1 FROM banned_ips WHERE ip = $1;', [
      clientIp,
    ]);
    const banned = check.rowCount > 0;
    bannedIpCache.set(clientIp, {
      banned,
      expiresAt: now + BANNED_IP_CACHE_TTL,
    });
    bannedIpDbRetryAfter = 0;
    if (banned)
      return res.status(403).json({ error: 'Yo IP addwess is banned bruh.' });
    next();
  } catch (err) {
    bannedIpDbRetryAfter = Date.now() + BANNED_IP_DB_RETRY_MS;
    log(
      'IP validation lookup unavailable; failing open for',
      BANNED_IP_DB_RETRY_MS + 'ms:',
      err.code || err.message,
    );
    next();
  }
}
app.use(blockBannedIPs);

const INITIAL_ADMIN_USERNAMES = new Set(['admin', 'lmao']);

const adminUserSql = (alias) =>
  `(${alias}.is_admin OR ${alias}.roles::jsonb @> '["admin"]')`;

const moderatorUserSql = (alias) =>
  `(${alias}.is_moderator OR ${alias}.roles::jsonb @> '["moderator"]')`;

const hasAdminPrivileges = (user) => !!(user && user.is_admin);
const hasModeratorPrivileges = (user) => !!(user && user.is_moderator);

async function getUserRoles(username) {
  const cacheKey = String(username || '').toLowerCase();
  const cached = userRoleCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const r = await db.query(
    `SELECT u.roles, u.timeout_until, u.is_banned, u.last_ip, u.is_admin, u.is_moderator,
            COALESCE(best.role, '') AS role_name,
            COALESCE(best.prefix, '') AS role_prefix,
            COALESCE(best.style, '') AS role_style,
            COALESCE(best.class, '') AS role_class
       FROM users u
       LEFT JOIN LATERAL (
         SELECT r.role, r.prefix, r.style, r.class
         FROM roles r
         WHERE r.role = ANY (SELECT jsonb_array_elements_text(u.roles::jsonb))
         ORDER BY CASE WHEN r.role IN ('admin', 'moderator') THEN 1 ELSE 0 END,
                  r.priority DESC
         LIMIT 1
       ) best ON true
      WHERE u.username = $1;`,
    [username],
  );

  const res = r.rows[0] || {
    roles: '[]',
    timeout_until: 0,
    is_banned: false,
    last_ip: null,
    is_admin: false,
    is_moderator: false,
    role_name: '',
    role_prefix: '',
    role_style: '',
    role_class: '',
  };
  try {
    res.roles = JSON.parse(res.roles || '[]');
  } catch {
    res.roles = [];
  }
  const roleList = Array.isArray(res.roles) ? res.roles : [];
  res.is_admin = !!res.is_admin || roleList.includes('admin');
  res.is_moderator = !!res.is_moderator || roleList.includes('moderator');
  res.role = {
    role:
      res.role_name ||
      (res.is_admin ? 'admin' : res.is_moderator ? 'moderator' : ''),
    prefix: res.role_name
      ? res.role_prefix
      : res.is_admin
        ? 'ADMIN'
        : res.is_moderator
          ? 'MOD'
          : '',
    style: res.role_style || '',
    class: res.role_class || '',
  };
  delete res.role_name;
  delete res.role_prefix;
  delete res.role_style;
  delete res.role_class;
  delete res.roles;

  userRoleCache.set(cacheKey, {
    value: res,
    expiresAt: now + USER_ROLE_CACHE_TTL,
  });
  return res;
}

async function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const roles = await getUserRoles(decoded.username);
    req.user = { ...decoded, ...roles };
    next();
  } catch (err) {
    log('Auth Token verification failed:', err.message);
    return res.status(403).json({ error: 'Invalid token' });
  }
}

const standardJsonParser = express.json({ limit: '1mb' });
const fandomJsonParser = express.json({ limit: '5mb' });
// Admin role CSS is stored in PostgreSQL TEXT, so its write routes have no
// configured body-size cap. The large parser is only selected after admin auth.
const unlimitedRoleJsonParser = express.json({ limit: Infinity });
app.use((req, res, next) => {
  if (
    req.method === 'POST' &&
    (req.path === '/api/fandom/login' || req.path === '/api/fandom/edit')
  ) {
    return fandomJsonParser(req, res, next);
  }

  const roleStyleWrite =
    (req.method === 'POST' && req.path === '/api/admin/roles') ||
    (req.method === 'PUT' && /^\/api\/admin\/roles\/[^/]+$/.test(req.path));
  if (!roleStyleWrite) return standardJsonParser(req, res, next);

  authenticateToken(req, res, () => {
    const parser = hasAdminPrivileges(req.user)
      ? unlimitedRoleJsonParser
      : standardJsonParser;
    parser(req, res, next);
  });
});

app.get('/portal-2d-editor.html', (req, res) => {
  res.sendFile('portal-2d-editor.html', { root: './static' });
});

app.use(express.static('./static/'));

function requestChangelogPage(page, perPage) {
  const key = `${page}:${perPage}`;
  let request = changelogRequests.get(key);
  if (request) return request;

  request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const url = new URL('https://api.github.com/repos/un-reader/unreader/commits');
      url.searchParams.set('per_page', String(perPage));
      url.searchParams.set('page', String(page));
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Unreader-Changelog',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`GitHub returned HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const commits = await response.json();
      if (!Array.isArray(commits)) throw new Error('Invalid GitHub response');

      const expiresAt = Date.now() + CHANGELOG_CACHE_TTL_MS;
      changelogCache.delete(key);
      changelogCache.set(key, { commits, expiresAt });
      while (changelogCache.size > CHANGELOG_CACHE_MAX_ENTRIES) {
        changelogCache.delete(changelogCache.keys().next().value);
      }
      try {
        await db.query(
          `INSERT INTO github_changelog_cache (page, per_page, commits, expires_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (page, per_page) DO UPDATE
           SET commits = EXCLUDED.commits, expires_at = EXCLUDED.expires_at`,
          [page, perPage, JSON.stringify(commits), expiresAt],
        );
        await db.query(
          `DELETE FROM github_changelog_cache
           WHERE ctid IN (
             SELECT ctid FROM github_changelog_cache
             ORDER BY expires_at DESC OFFSET $1
           )`,
          [CHANGELOG_CACHE_MAX_ENTRIES],
        );
      } catch (error) {
        log('Persistent changelog cache write failed:', error.message);
      }
      return commits;
    } finally {
      clearTimeout(timeout);
    }
  })();
  changelogRequests.set(key, request);
  const clearRequest = () => {
    if (changelogRequests.get(key) === request) changelogRequests.delete(key);
  };
  request.then(clearRequest, clearRequest);
  return request;
}

async function refreshLatestChangelog() {
  const page = 1;
  const perPage = CHANGELOG_LATEST_PAGE_SIZE;
  const key = `${page}:${perPage}`;
  let cached = changelogCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    try {
      const result = await db.query(
        'SELECT commits, expires_at FROM github_changelog_cache WHERE page = $1 AND per_page = $2',
        [page, perPage],
      );
      if (result.rows[0]) {
        cached = {
          commits: result.rows[0].commits,
          expiresAt: Number(result.rows[0].expires_at),
        };
        changelogCache.set(key, cached);
      }
    } catch (error) {
      log('Persistent changelog cache read failed:', error.message);
    }
  }
  if (cached && cached.expiresAt > Date.now()) return;

  try {
    await requestChangelogPage(page, perPage);
    log('Daily GitHub changelog refresh completed.');
  } catch (error) {
    log('Daily GitHub changelog refresh failed:', error.message);
  }
}

databaseReady.then(() => {
  refreshLatestChangelog();
  setInterval(refreshLatestChangelog, CHANGELOG_REFRESH_CHECK_INTERVAL_MS);
});

app.get('/api/commits', async (req, res) => {
  const page = Number.parseInt(req.query.page, 10);
  const perPage = Number.parseInt(req.query.per_page, 10);
  if (!Number.isInteger(page) || page < 1 || page > 2000) {
    return res.status(400).json({ error: 'Invalid commit page.' });
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    return res.status(400).json({ error: 'Invalid commits per page.' });
  }

  const key = `${page}:${perPage}`;
  let cached = changelogCache.get(key);
  const now = Date.now();
  if (!cached || cached.expiresAt <= now) {
    try {
      const result = await db.query(
        'SELECT commits, expires_at FROM github_changelog_cache WHERE page = $1 AND per_page = $2',
        [page, perPage],
      );
      const row = result.rows[0];
      if (row && (!cached || Number(row.expires_at) > cached.expiresAt)) {
        cached = { commits: row.commits, expiresAt: Number(row.expires_at) };
        changelogCache.set(key, cached);
      }
    } catch (error) {
      log('Persistent changelog cache read failed:', error.message);
    }
  }
  if (cached && cached.expiresAt > now) {
    return res
      .set('Cache-Control', 'public, max-age=300')
      .set('X-Changelog-Cache', 'HIT')
      .json(cached.commits);
  }

  const request = requestChangelogPage(page, perPage);

  try {
    const commits = await request;
    res
      .set('Cache-Control', 'public, max-age=300')
      .set('X-Changelog-Cache', 'MISS')
      .json(commits);
  } catch (error) {
    if (cached) {
      return res
        .set('Cache-Control', 'public, max-age=60')
        .set('X-Changelog-Cache', 'STALE')
        .json(cached.commits);
    }
    const rateLimited = error.status === 403 || error.status === 429;
    log('GitHub changelog request failed:', error.message);
    res.status(502).json({
      error: rateLimited ? 'rate_limited' : 'github_unavailable',
    });
  }
});

const fandomEditorSessions = new Map();
const FANDOM_EDITOR_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const FANDOM_EDITOR_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getFandomHost(value) {
  const host = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  if (!/^[a-z0-9-]+\.fandom\.com$/.test(host)) {
    throw new Error(
      'Enter a Fandom wiki hostname, such as minecraft.fandom.com.',
    );
  }
  return host;
}

function mergeFandomCookies(existing, response) {
  const jar = Object.create(null);
  String(existing || '')
    .split(';')
    .forEach((part) => {
      const index = part.indexOf('=');
      if (index > 0)
        jar[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    });
  let setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') || ''];
  setCookies.forEach((line) => {
    const pair = String(line).split(';')[0];
    const index = pair.indexOf('=');
    if (index < 1) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (/max-age=0/i.test(line) || /expires=thu, 01 jan 1970/i.test(line))
      delete jar[name];
    else jar[name] = value;
  });
  return Object.keys(jar)
    .map((name) => name + '=' + jar[name])
    .join('; ');
}

async function requestFandomApi(host, params, cookie, method) {
  const query = new URLSearchParams();
  let body;
  if (method === 'POST') {
    body = new URLSearchParams(params).toString();
  } else {
    Object.keys(params).forEach((key) => query.set(key, params[key]));
  }
  const url =
    'https://' +
    host +
    '/api.php' +
    (method === 'POST' ? '' : '?' + query.toString());
  const headers = { 'User-Agent': 'UnreaderWikiEditor/1.0' };
  if (cookie) headers.Cookie = cookie;
  if (method === 'POST')
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(url, {
    method: method || 'GET',
    headers: headers,
    body: body,
  });
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error('The Fandom API returned an unreadable response.');
  }
  if (!response.ok)
    throw new Error(
      'Fandom API request failed (HTTP ' + response.status + ').',
    );
  if (data && data.error) {
    const apiError = new Error(
      data.error.info || data.error.code || 'Fandom API request failed.',
    );
    apiError.code = data.error.code || '';
    throw apiError;
  }
  return { data: data, cookie: mergeFandomCookies(cookie, response) };
}

function readFandomSessionId(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (let i = 0; i < cookies.length; i++) {
    const pair = cookies[i].trim().split('=');
    if (pair[0] === 'fandom_editor_session') return pair.slice(1).join('=');
  }
  return '';
}

function setFandomSessionCookie(req, res, sessionId, ttlMs, clear) {
  res.cookie('fandom_editor_session', clear ? '' : sessionId, {
    httpOnly: true,
    secure: !!req.secure,
    sameSite: 'strict',
    path: '/api/fandom',
    maxAge: clear ? 0 : ttlMs,
  });
}

function getFandomSession(req) {
  const sessionId = readFandomSessionId(req);
  const session = sessionId && fandomEditorSessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    fandomEditorSessions.delete(sessionId);
    return null;
  }
  session.expiresAt = Date.now() + session.ttlMs;
  return session;
}

app.post('/api/fandom/login', async (req, res) => {
  let host;
  try {
    host = getFandomHost(req.body && req.body.wiki);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  const username =
    typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password =
    typeof req.body.password === 'string' ? req.body.password : '';
  const ttlMs =
    req.body.remember === true
      ? FANDOM_EDITOR_REMEMBER_TTL_MS
      : FANDOM_EDITOR_SESSION_TTL_MS;
  if (
    !username ||
    username.length > 128 ||
    !password ||
    password.length > 512
  ) {
    return res
      .status(400)
      .json({ error: 'Enter your Fandom BotPassword username and password.' });
  }

  try {
    const tokenResponse = await requestFandomApi(host, {
      action: 'query',
      meta: 'tokens',
      type: 'login',
      format: 'json',
      formatversion: '2',
    });
    const loginToken =
      tokenResponse.data.query &&
      tokenResponse.data.query.tokens &&
      tokenResponse.data.query.tokens.logintoken;
    if (!loginToken) throw new Error('Fandom did not provide a login token.');
    const loginResponse = await requestFandomApi(
      host,
      {
        action: 'login',
        lgname: username,
        lgpassword: password,
        lgtoken: loginToken,
        format: 'json',
        formatversion: '2',
      },
      tokenResponse.cookie,
      'POST',
    );
    const login = loginResponse.data.login || {};
    if (login.result !== 'Success') {
      return res
        .status(401)
        .json({
          error:
            login.reason ||
            login.message ||
            'Fandom sign-in failed. Check the BotPassword details.',
        });
    }

    const sessionId = randomUUID();
    fandomEditorSessions.set(sessionId, {
      host: host,
      username: login.lgusername || username.split('@')[0],
      cookie: loginResponse.cookie,
      ttlMs: ttlMs,
      remember: req.body.remember === true,
      expiresAt: Date.now() + ttlMs,
    });
    setFandomSessionCookie(req, res, sessionId, ttlMs, false);
    res.json({
      success: true,
      username: login.lgusername || username.split('@')[0],
      wiki: host,
      remember: req.body.remember === true,
    });
  } catch (error) {
    log('Fandom API sign-in failed:', error.message);
    res
      .status(502)
      .json({
        error: 'Could not sign in through that wiki API: ' + error.message,
      });
  }
});

app.get('/api/fandom/session', (req, res) => {
  const session = getFandomSession(req);
  if (!session)
    return res
      .status(401)
      .json({ error: 'Sign in with a Fandom BotPassword to edit.' });
  setFandomSessionCookie(
    req,
    res,
    readFandomSessionId(req),
    session.ttlMs,
    false,
  );
  res.json({
    username: session.username,
    wiki: session.host,
    remember: session.remember,
  });
});

app.post('/api/fandom/logout', (req, res) => {
  const sessionId = readFandomSessionId(req);
  if (sessionId) fandomEditorSessions.delete(sessionId);
  setFandomSessionCookie(req, res, '', 0, true);
  res.json({ success: true });
});

app.get('/api/fandom/page', async (req, res) => {
  const session = getFandomSession(req);
  if (!session)
    return res
      .status(401)
      .json({
        error: 'Your Fandom editor session has expired. Sign in again.',
      });
  setFandomSessionCookie(
    req,
    res,
    readFandomSessionId(req),
    session.ttlMs,
    false,
  );
  const title = String(req.query.title || '').trim();
  if (!title || title.length > 255)
    return res
      .status(400)
      .json({ error: 'Enter a page title (up to 255 characters).' });
  try {
    const result = await requestFandomApi(
      session.host,
      {
        action: 'query',
        prop: 'revisions',
        titles: title,
        rvprop: 'content|timestamp',
        rvslots: 'main',
        curtimestamp: '1',
        format: 'json',
        formatversion: '2',
      },
      session.cookie,
    );
    session.cookie = result.cookie;
    const page =
      result.data.query &&
      result.data.query.pages &&
      result.data.query.pages[0];
    const revision = page && page.revisions && page.revisions[0];
    const slot = revision && revision.slots && revision.slots.main;
    res.json({
      title: page ? page.title : title,
      content: slot ? slot.content || slot['*'] || '' : '',
      basetimestamp: revision ? revision.timestamp : '',
      starttimestamp: result.data.curtimestamp || new Date().toISOString(),
      missing: !!(page && page.missing),
    });
  } catch (error) {
    log('Fandom page load failed:', error.message);
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/fandom/edit', async (req, res) => {
  const session = getFandomSession(req);
  if (!session)
    return res
      .status(401)
      .json({
        error: 'Your Fandom editor session has expired. Sign in again.',
      });
  setFandomSessionCookie(
    req,
    res,
    readFandomSessionId(req),
    session.ttlMs,
    false,
  );
  const body = req.body || {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';
  const summary =
    typeof body.summary === 'string' ? body.summary.trim().slice(0, 500) : '';
  if (!title || title.length > 255)
    return res
      .status(400)
      .json({ error: 'Enter a page title (up to 255 characters).' });
  if (Buffer.byteLength(content, 'utf8') > 4 * 1024 * 1024)
    return res
      .status(413)
      .json({ error: 'Page text exceeds the 4 MB editor limit.' });

  try {
    const tokenResult = await requestFandomApi(
      session.host,
      {
        action: 'query',
        meta: 'tokens',
        type: 'csrf',
        format: 'json',
        formatversion: '2',
      },
      session.cookie,
    );
    session.cookie = tokenResult.cookie;
    const csrfToken =
      tokenResult.data.query &&
      tokenResult.data.query.tokens &&
      tokenResult.data.query.tokens.csrftoken;
    if (!csrfToken)
      throw new Error(
        'Fandom did not provide an edit token. Please sign in again.',
      );
    const editParams = {
      action: 'edit',
      title: title,
      text: content,
      summary: summary,
      token: csrfToken,
      format: 'json',
      formatversion: '2',
    };
    if (body.basetimestamp)
      editParams.basetimestamp = String(body.basetimestamp);
    if (body.starttimestamp)
      editParams.starttimestamp = String(body.starttimestamp);
    const editResult = await requestFandomApi(
      session.host,
      editParams,
      session.cookie,
      'POST',
    );
    session.cookie = editResult.cookie;
    const edit = editResult.data.edit || {};
    if (edit.result !== 'Success')
      return res.status(502).json({ error: 'Fandom did not save the page.' });
    res.json({
      success: true,
      title: edit.title || title,
      newrevid: edit.newrevid || null,
      newtimestamp: edit.newtimestamp || '',
    });
  } catch (error) {
    const status = error.code === 'editconflict' ? 409 : 502;
    log('Fandom page save failed:', error.code || error.message);
    res
      .status(status)
      .json({
        error:
          error.code === 'editconflict'
            ? 'This page changed on Fandom after you loaded it. Reload it before saving your edit.'
            : error.message,
      });
  }
});

const activeClients = new Map();
const screenshares = {};

function broadcastSystemUpdate(payloadObj, filterFn = null) {
  const msgStr = JSON.stringify(payloadObj);
  activeClients.forEach((client, username) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      if (!filterFn || filterFn(client, username)) {
        if (client.ws.bufferedAmount > 1024 * 1024) {
          log(
            `Backpressure: skipping oversized WebSocket queue for ${username}`,
          );
          return;
        }
        client.ws.send(msgStr);
      }
    } else {
      log(`Pruning inactive connection: ${username}`);
      activeClients.delete(username);
    }
  });
}

function getRosterPayload() {
  const users = [];
  activeClients.forEach((c, username) => {
    users.push({
      username: username,
      mode: c.mode || 'public',
      target: c.target || '',
      userRoles: c.userRoles,
      screensharing: screenshares[username] != null
    });
  });
  return { type: 'roster_update', users };
}

app.get('/dm-contacts', authenticateToken, async (req, res) => {
  const result = await db.query(
    `SELECT DISTINCT username FROM (SELECT receiver AS username FROM dms WHERE sender = $1 UNION SELECT sender AS username FROM dms WHERE receiver = $1) AS c WHERE username != $1;`,
    [req.user.username],
  );
  res.json(result.rows.map((r) => r.username));
});

const PET_PNG_PREFIX = 'data:image/png;base64,';
const PET_DATA_MAX_LENGTH = 900000;
const PET_MAX_FRAMES = 64;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isValidPetFrame(value) {
  if (
    typeof value !== 'string' ||
    value.length > 12000 ||
    !value.startsWith(PET_PNG_PREFIX)
  )
    return false;

  const base64 = value.slice(PET_PNG_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false;
  const png = Buffer.from(base64, 'base64');
  return (
    png.toString('base64') === base64 &&
    png.length >= 24 &&
    png.subarray(0, 8).equals(PNG_SIGNATURE) &&
    png.readUInt32BE(16) === 32 &&
    png.readUInt32BE(20) === 32
  );
}

function isValidPetData(value) {
  if (typeof value !== 'string' || value.length > PET_DATA_MAX_LENGTH)
    return false;
  if (value.startsWith(PET_PNG_PREFIX)) return isValidPetFrame(value);
  try {
    const pet = JSON.parse(value);
    if (Array.isArray(pet))
      return pet.length === 32 && pet.every(isValidPetFrame);
    if (
      !pet ||
      pet.version !== 2 ||
      !Array.isArray(pet.frames) ||
      pet.frames.length < 32 ||
      pet.frames.length > PET_MAX_FRAMES ||
      !pet.frames.every(isValidPetFrame) ||
      !Array.isArray(pet.actions) ||
      pet.actions.length !== 18
    )
      return false;
    const states = new Set();
    return pet.actions.every((action) => {
      if (
        !action ||
        !Number.isInteger(action.state) ||
        action.state < 0 ||
        action.state >= 18 ||
        states.has(action.state) ||
        !Array.isArray(action.frames) ||
        action.frames.length === 0 ||
        action.frames.length > PET_MAX_FRAMES ||
        !action.frames.every(
          (frame) =>
            Number.isInteger(frame) && frame >= 0 && frame < pet.frames.length,
        )
      )
        return false;
      states.add(action.state);
      return true;
    });
  } catch {
    return false;
  }
}

app.get('/api/pets', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT "pet-name" AS name, "created-by" AS created_by,
              "pet-data" AS pet_data, TO_CHAR("date-release", 'YYYY-MM-DD') AS date_release
         FROM pets
        ORDER BY "date-release" DESC NULLS LAST, "pet-name" ASC
        LIMIT 100;`,
    );
    res.json(
      result.rows.filter(
        (pet) =>
          pet.name &&
          pet.created_by &&
          pet.date_release &&
          isValidPetData(pet.pet_data),
      ),
    );
  } catch (err) {
    log('Pet library load failed:', err.message);
    res.status(500).json({ error: 'Could not load the pet library.' });
  }
});

app.post('/api/pets', authenticateToken, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const petData = req.body?.pet_data;
  if (!name || name.length > 255) {
    return res
      .status(400)
      .json({ error: 'Pet name must be between 1 and 255 characters.' });
  }
  if (!isValidPetData(petData)) {
    return res
      .status(400)
      .json({ error: 'Pet must contain valid 32x32 PNG frames.' });
  }

  try {
    await db.query(
      `INSERT INTO pets ("pet-name", "created-by", "pet-data", "date-release")
       VALUES ($1, $2, $3, CURRENT_DATE);`,
      [name, req.user.username, petData],
    );
    res.status(201).json({ success: true });
  } catch (err) {
    log('Pet publishing failed:', err.message);
    res.status(500).json({ error: 'Could not publish the pet.' });
  }
});

function isValidGitHubTokenVault(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.version === 2 &&
    value.context === 'unreader-github-token-pin-v2' &&
    value.kdf === 'PBKDF2-SHA-256' &&
    value.iterations === 600000 &&
    value.cipher === 'AES-GCM-256' &&
    /^[A-Za-z0-9+/]{20,24}={0,2}$/.test(value.salt || '') &&
    /^[A-Za-z0-9+/]{16}={0,2}$/.test(value.iv || '') &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext || '') &&
    value.ciphertext.length <= 12000
  );
}

app.get('/api/user/github-token-vault', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT "GitHubTokenData", github_token FROM users WHERE username = $1;',
      [req.user.username],
    );
    let data = null;
    if (result.rows[0] && result.rows[0].GitHubTokenData) {
      try {
        data = JSON.parse(result.rows[0].GitHubTokenData);
      } catch (error) {
        return res.status(500).json({ error: 'Saved GitHub key data is invalid.' });
      }
    }
    res.json({ data, legacyToken: result.rows[0]?.github_token || null });
  } catch (error) {
    log('GitHub key lookup failed:', error.message);
    res.status(500).json({ error: 'Could not load saved GitHub key data.' });
  }
});

app.put('/api/user/github-token-vault', authenticateToken, async (req, res) => {
  const data = req.body && req.body.data;
  if (!isValidGitHubTokenVault(data))
    return res.status(400).json({ error: 'Encrypted GitHub key data is invalid.' });
  try {
    // A successful encrypted save also removes the old plaintext account copy.
    await db.query(
      'UPDATE users SET "GitHubTokenData" = $1, github_token = NULL WHERE username = $2;',
      [JSON.stringify(data), req.user.username],
    );
    res.json({ success: true });
  } catch (error) {
    log('GitHub key save failed:', error.message);
    res.status(500).json({ error: 'Could not save encrypted GitHub key data.' });
  }
});

app.delete('/api/user/github-token-vault', authenticateToken, async (req, res) => {
  try {
    await db.query(
      'UPDATE users SET "GitHubTokenData" = NULL, github_token = NULL WHERE username = $1;',
      [req.user.username],
    );
    res.json({ success: true });
  } catch (error) {
    log('GitHub key removal failed:', error.message);
    res.status(500).json({ error: 'Could not remove saved GitHub key data.' });
  }
});

// Prevent older clients from continuing to store GitHub tokens in plaintext.
app.post('/api/user/github-token', authenticateToken, (req, res) => {
  res.status(410).json({ error: 'Plaintext GitHub key saving is disabled. Update the GitHub app to use PIN-protected saving.' });
});

// The server never sees the PIN. It only checks that what it is asked to store
// has the shape of a PIN-vault record, then stores it as opaque text.
function isValidBotPasswordVault(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.version === 2 &&
    value.context === 'unreader-fandom-botpassword-pin-v2' &&
    value.kdf === 'PBKDF2-SHA-256' &&
    value.iterations === 600000 &&
    value.cipher === 'AES-GCM-256' &&
    /^[A-Za-z0-9+/]{20,24}={0,2}$/.test(value.salt || '') &&
    /^[A-Za-z0-9+/]{16}={0,2}$/.test(value.iv || '') &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext || '') &&
    value.ciphertext.length <= 12000
  );
}

app.get('/api/user/fandom-botpassword', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT "BotPasswordData" FROM users WHERE username = $1;',
      [req.user.username],
    );
    let data = null;
    if (result.rows[0] && result.rows[0].BotPasswordData) {
      try {
        data = JSON.parse(result.rows[0].BotPasswordData);
      } catch (error) {
        return res
          .status(500)
          .json({ error: 'Saved Fandom credential data is invalid.' });
      }
    }
    res.json({ data: data });
  } catch (error) {
    log('Fandom credential lookup failed:', error.message);
    res
      .status(500)
      .json({ error: 'Could not load saved Fandom credential data.' });
  }
});

app.put('/api/user/fandom-botpassword', authenticateToken, async (req, res) => {
  const data = req.body && req.body.data;
  if (!isValidBotPasswordVault(data))
    return res
      .status(400)
      .json({ error: 'Encrypted Fandom credential data is invalid.' });
  try {
    await db.query(
      'UPDATE users SET "BotPasswordData" = $1 WHERE username = $2;',
      [JSON.stringify(data), req.user.username],
    );
    res.json({ success: true });
  } catch (error) {
    log('Fandom credential save failed:', error.message);
    res
      .status(500)
      .json({ error: 'Could not save encrypted Fandom credential data.' });
  }
});

app.delete(
  '/api/user/fandom-botpassword',
  authenticateToken,
  async (req, res) => {
    try {
      await db.query(
        'UPDATE users SET "BotPasswordData" = NULL WHERE username = $1;',
        [req.user.username],
      );
      res.json({ success: true });
    } catch (error) {
      log('Fandom credential removal failed:', error.message);
      res
        .status(500)
        .json({ error: 'Could not remove saved Fandom credential data.' });
    }
  },
);

app.post('/api/register', async (req, res) => {
  let { username, password } = req.body;
  username = sanitizeUsername(username);
  if (!username || username.length < 3)
    return res.status(400).json({ error: 'Username invalid or too short' });

  const ip =
    req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`Registration request: ${username} from ${ip}`);
  try {
    const hash = await bcrypt.hash(password, 10);
    const isInitialAdmin = INITIAL_ADMIN_USERNAMES.has(username.toLowerCase());
    await db.query(
      'INSERT INTO users (username, password_hash, last_ip, is_admin) VALUES ($1, $2, $3, $4);',
      [username, hash, ip, isInitialAdmin],
    );
    await db.query(
      'INSERT INTO profiles (username) VALUES ($1) ON CONFLICT DO NOTHING;',
      [username],
    );
    res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
  } catch (err) {
    log('Registration collision/error:', err.message);
    res.status(400).json({ error: 'Username already taken' });
  }
});

app.post('/api/login', async (req, res) => {
  let { username, password } = req.body;
  username = sanitizeUsername(username);
  const ip =
    req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`Login request: ${username} from ${ip}`);
  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1;', [
      username,
    ]);
    const user = result.rows[0];
    if (
      !user ||
      user.is_banned ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      log(`Login REJECTED for ${username}`);
      return res.status(401).json({ error: 'Rejected' });
    }
    await db.query('UPDATE users SET last_ip = $1 WHERE username = $2;', [
      ip,
      username,
    ]);
    log(`Login SUCCESS: ${username}`);
    res.json({ token: jwt.sign({ username }, JWT_SECRET), username });
  } catch (err) {
    log('Login logic breakdown:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  try {
    const user = req.user;
    const result = await db.query('SELECT * FROM users WHERE username = $1;', [
      user.username,
    ]);
    const dbUser = result.rows[0];
    if (
      !dbUser ||
      !(await bcrypt.compare(currentPassword, dbUser.password_hash))
    ) {
      log(`Password change REJECTED for ${user.username}`);
      return res.status(401).json({
        error: 'Rejected. Incorrect current password or user does not exist.',
      });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = $1 WHERE username = $2;', [
      hash,
      user.username,
    ]);
    log(`Password change SUCCESS: ${user.username}`);
    res.json({ success: true });
  } catch (err) {
    log('Password change logic breakdown:', err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.get('/api/doodle/leaderboard', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT username, score FROM doodle_scores ORDER BY score DESC, updated_at ASC, LOWER(username) ASC LIMIT 25;',
    );
    res.json({ scores: result.rows });
  } catch (err) {
    log('Doodle leaderboard load failed:', err.message);
    res.status(500).json({ error: 'Could not load leaderboard.' });
  }
});

app.post('/api/doodle/score', authenticateToken, async (req, res) => {
  const score = req.body && req.body.score;
  if (!Number.isInteger(score) || score < 1 || score > 10000000) {
    return res.status(400).json({ error: 'Score is invalid.' });
  }
  try {
    const result = await db.query(
      `INSERT INTO doodle_scores (username, score, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE
       SET score = GREATEST(doodle_scores.score, EXCLUDED.score),
           updated_at = CASE WHEN EXCLUDED.score > doodle_scores.score
                             THEN EXCLUDED.updated_at ELSE doodle_scores.updated_at END
       RETURNING score;`,
      [req.user.username, score, Date.now()],
    );
    res.json({ success: true, score: result.rows[0].score });
  } catch (err) {
    log('Doodle score save failed:', err.message);
    res.status(500).json({ error: 'Could not save score.' });
  }
});

app.get('/api/profile/:username', authenticateToken, async (req, res) => {
  const targetUsername = sanitizeUsername(req.params.username);
  const r = await db.query(
    `SELECT u.username, COALESCE(p.bio, 'Hello world.') AS bio, COALESCE(p.location, 'Cyberspace') AS location, COALESCE(p.avatar_emoji, '👤') AS avatar_emoji, i.image_data, ${adminUserSql('u')} AS is_admin, ${moderatorUserSql('u')} AS is_moderator FROM users u LEFT JOIN profiles p ON p.username = u.username LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(u.username) ORDER BY (username = u.username) DESC LIMIT 1) i ON true WHERE u.username = $1;`,
    [targetUsername],
  );
  if (!r.rows[0]) {
    const image = await db.query(
      `SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER($1) ORDER BY (username = $1) DESC LIMIT 1;`,
      [targetUsername],
    );
    return res.json({
      username: targetUsername,
      bio: 'Hello world.',
      location: 'Cyberspace',
      avatar_emoji: '👤',
      image_data: image.rows[0]?.image_data || null,
      is_admin: false,
      is_moderator: false,
    });
  }
  res.json(r.rows[0]);
});

app.post('/api/profile', authenticateToken, async (req, res) => {
  let { bio, location, avatar_emoji, avatar_type, image_data } = req.body;
  bio = sanitize(bio);
  location = sanitize(location);
  avatar_emoji = sanitize(avatar_emoji);

  if (avatar_type !== undefined && !['emoji', 'picture'].includes(avatar_type))
    return res.status(400).json({ error: 'Choose an emoji or picture avatar.' });
  if (avatar_type === 'emoji') image_data = '';
  if (avatar_type === 'picture' && !validProfileImage(image_data))
    return res.status(400).json({ error: 'Draw or import a picture before saving.' });

  if (image_data !== undefined && image_data !== null && image_data !== '') {
    if (!validProfileImage(image_data))
      return res
        .status(400)
        .json({
          error: 'Profile picture must be a valid base64 PNG under 512 KB.',
        });
  }

  await db.query(
    'INSERT INTO profiles (username, bio, location, avatar_emoji) VALUES ($4, $1, $2, $3) ON CONFLICT (username) DO UPDATE SET bio=$1, location=$2, avatar_emoji=$3;',
    [bio, location, avatar_emoji, req.user.username],
  );
  if (image_data === '') {
    await db.query('DELETE FROM profile_images WHERE username = $1;', [
      req.user.username,
    ]);
  } else if (image_data !== undefined && image_data !== null) {
    await db.query(
      'INSERT INTO profile_images (username, image_data, "user") VALUES ($1, $2, \'user\') ON CONFLICT (username) DO UPDATE SET image_data = EXCLUDED.image_data;',
      [req.user.username, image_data],
    );
  }
  res.json({ success: true });
});

app.get('/api/mod-logs', authenticateToken, async (req, res) => {
  if (!hasAdminPrivileges(req.user) && !hasModeratorPrivileges(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  const r = await db.query('SELECT * FROM mod_logs ORDER BY id DESC LIMIT 50;');
  const tr = r.rows;
  const rows = [];
  for (const row of tr) {
    row.reason = sanitize(row.reason);
    row.mod_username = sanitize(row.mod_username);
    row.target_username = sanitize(row.target_username);
    if (row.action_type === 'delete') {
      const dbResult = await db.query(
        'SELECT content FROM messages WHERE id = $1;',
        [row.target_id],
      );
      row.content = dbResult.rows.length
        ? dbResult.rows[0].content
        : 'Content not found or already deleted.';
    }
    rows.push(row);
  }
  res.json(rows);
});

function canManageProfilePictures(user) {
  return hasAdminPrivileges(user) || hasModeratorPrivileges(user);
}

function validProfileImage(imageData) {
  if (
    typeof imageData !== 'string' ||
    imageData.length > 700000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      imageData,
    )
  )
    return false;
  const bytes = Buffer.from(imageData, 'base64');
  return (
    bytes.length > 0 &&
    bytes.length <= 512000 &&
    bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  );
}

app.get('/api/mod/profile-images', authenticateToken, async (req, res) => {
  if (!canManageProfilePictures(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  const page = Math.max(0, parseInt(req.query.index, 10) || 0);
  const search = String(req.query.search || '')
    .trim()
    .replace(/^@+/, '')
    .slice(0, 32);
  const result = await db.query(
    `WITH pictures AS (
       SELECT u.username, pi.image_data
       FROM users u
       LEFT JOIN LATERAL (
         SELECT image_data FROM profile_images
         WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(u.username)
         ORDER BY (username = u.username) DESC LIMIT 1
       ) pi ON true
       UNION ALL
       SELECT pi.username, pi.image_data FROM profile_images pi
       WHERE NOT EXISTS (
         SELECT 1 FROM users u
         WHERE LOWER(TRIM(LEADING '@' FROM pi.username)) = LOWER(u.username)
       )
     )
     SELECT username, image_data FROM pictures
     WHERE $1 = '' OR username ILIKE '%' || $1 || '%'
     ORDER BY LOWER(username), username
     LIMIT 21 OFFSET $2;`,
    [search, page * 20],
  );
  res.json({
    images: result.rows.slice(0, 20),
    hasMore: result.rows.length > 20,
  });
});

app.put(
  '/api/mod/profile-images/:username',
  authenticateToken,
  async (req, res) => {
    if (!canManageProfilePictures(req.user))
      return res.status(403).json({ error: 'Unauthorized' });
    const target = sanitizeUsername(req.params.username);
    const imageData = req.body.image_data;
    if (!validProfileImage(imageData))
      return res
        .status(400)
        .json({
          error: 'A valid PNG profile picture under 512 KB is required.',
        });
    const existing = await db.query(
      `SELECT username FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER($1) ORDER BY (username = $1) DESC LIMIT 1;`,
      [target],
    );
    const row = existing.rows[0];
    if (row) {
      await db.query(
        'UPDATE profile_images SET image_data = $1 WHERE username = $2;',
        [imageData, row.username],
      );
    } else {
      const user = await db.query(
        'SELECT username FROM users WHERE LOWER(username) = LOWER($1);',
        [target],
      );
      if (!user.rows[0])
        return res.status(404).json({ error: 'User not found.' });
      await db.query(
        'INSERT INTO profile_images (username, image_data, "user") VALUES ($1, $2, \'user\');',
        [user.rows[0].username, imageData],
      );
    }
    await db.query(
      'INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);',
      [
        req.user.username,
        'profile_picture_change',
        target,
        'Moderator updated profile picture',
        Date.now(),
      ],
    );
    res.json({ success: true });
  },
);

app.delete(
  '/api/mod/profile-images/:username',
  authenticateToken,
  async (req, res) => {
    if (!canManageProfilePictures(req.user))
      return res.status(403).json({ error: 'Unauthorized' });
    const target = sanitizeUsername(req.params.username);
    const existing = await db.query(
      `SELECT username FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER($1) ORDER BY (username = $1) DESC LIMIT 1;`,
      [target],
    );
    if (!existing.rows[0])
      return res.status(404).json({ error: 'Profile picture not found.' });
    await db.query('DELETE FROM profile_images WHERE username = $1;', [
      existing.rows[0].username,
    ]);
    await db.query(
      'INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);',
      [
        req.user.username,
        'profile_picture_delete',
        target,
        'Moderator deleted profile picture',
        Date.now(),
      ],
    );
    res.json({ success: true });
  },
);

app.get(
  '/api/admin/find-user/:username',
  authenticateToken,
  async (req, res) => {
    if (!hasAdminPrivileges(req.user) && !hasModeratorPrivileges(req.user))
      return res.status(403).json({ error: 'Unauthorized' });
    const targetUsername = sanitizeUsername(req.params.username);
    log(
      `Admin User-Search: target=${targetUsername} by=${req.user.username} who is (${req.user.role.role})`,
    );
    const r = await db.query(
      'SELECT username, last_ip, timeout_until, is_banned, roles, is_moderator, is_admin FROM users WHERE username = $1;',
      [targetUsername],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    const userInfo = r.rows[0];
    userInfo.roles = JSON.parse(userInfo.roles);

    userInfo.roles.sort(async (a, b) => {
      const aRole = await db.query(
        'SELECT priority FROM roles WHERE role = $1;',
        [a],
      );
      const bRole = await db.query(
        'SELECT priority FROM roles WHERE role = $1;',
        [b],
      );
      const aPriority = aRole.rows[0]?.priority || 0;
      const bPriority = bRole.rows[0]?.priority || 0;
      return bPriority - aPriority;
    });

    let alts = [];
    if (userInfo.last_ip) {
      const altsRes = await db.query(
        'SELECT username FROM users WHERE last_ip = $1 AND username <> $2;',
        [userInfo.last_ip, userInfo.username],
      );
      alts = altsRes.rows.map((r) => r.username);
    }

    if (!hasAdminPrivileges(req.user)) {
      userInfo.last_ip = '[redacted]';
    }
    res.json({ ...userInfo, alts });
  },
);

app.post('/api/admin/set-role', authenticateToken, async (req, res) => {
  if (!hasAdminPrivileges(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  let { target, is_moderator } = req.body;
  target = sanitizeUsername(target);
  log(
    `Role Assignment: ${target} -> mod=${is_moderator} by=${req.user.username}`,
  );
  let roles = await db.query('SELECT roles FROM users WHERE username = $1;', [
    target,
  ]);
  roles = JSON.parse(roles.rows[0].roles);
  if (is_moderator && !roles.includes('moderator')) {
    roles.push('moderator');
  } else if (!is_moderator && roles.includes('moderator')) {
    roles = roles.filter((role) => role !== 'moderator');
  }
  await db.query('UPDATE users SET roles = $1 WHERE username = $2;', [
    JSON.stringify(roles),
    target,
  ]);
  invalidateUserRoleCache(target);
  res.json({ success: true });
});

app.get('/api/admin/roles', authenticateToken, async (req, res) => {
  if (!hasAdminPrivileges(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  try {
    const result = await db.query(
      'SELECT role, prefix, style, class, priority FROM roles ORDER BY priority DESC, role ASC;',
    );
    res.json({ roles: result.rows });
  } catch (error) {
    log('Role list query failed:', error.message);
    res
      .status(503)
      .json({ error: 'Database temporarily unavailable. Try again shortly.' });
  }
});

app.post('/api/admin/roles', authenticateToken, async (req, res) => {
  if (!hasAdminPrivileges(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  const body = req.body || {};
  const role =
    typeof body.role === 'string' ? body.role.trim().toLowerCase() : '';
  const prefix = typeof body.prefix === 'string' ? body.prefix.trim() : '';
  const style = typeof body.style === 'string' ? body.style.trim() : '';
  const roleClass = typeof body.class === 'string' ? body.class.trim() : '';
  const priority = Number(body.priority || 0);
  if (
    !/^[a-z][a-z0-9_-]{1,31}$/.test(role) ||
    ['admin', 'moderator'].includes(role)
  ) {
    return res
      .status(400)
      .json({
        error:
          'Use a 2–32 character role name; admin and moderator are reserved.',
      });
  }
  if (
    prefix.length > 32 ||
    roleClass.length > 128 ||
    (roleClass && !/^[a-zA-Z0-9 _-]+$/.test(roleClass)) ||
    !Number.isInteger(priority) ||
    priority < -1000 ||
    priority > 1000
  ) {
    return res
      .status(400)
      .json({
        error: 'Check the prefix, CSS style, class, and priority fields.',
      });
  }
  try {
    await db.query(
      'INSERT INTO roles (role, prefix, style, class, priority) VALUES ($1, $2, $3, $4, $5);',
      [role, prefix, style, roleClass, priority],
    );
  } catch (error) {
    if (error.code === '23505')
      return res.status(409).json({ error: 'That role already exists.' });
    log('Role creation failed:', error.message);
    return res
      .status(503)
      .json({ error: 'Database temporarily unavailable. Try again shortly.' });
  }
  try {
    await db.query(
      'INSERT INTO mod_logs (mod_username, action_type, reason, timestamp) VALUES ($1, $2, $3, $4);',
      [req.user.username, 'role_create', role, Date.now()],
    );
  } catch (error) {
    log('Role creation audit log failed:', error.message);
  }
  res.json({ success: true, role });
});

app.put('/api/admin/roles/:role', authenticateToken, async (req, res) => {
  if (!hasAdminPrivileges(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  const role = String(req.params.role || '')
    .trim()
    .toLowerCase();
  if (
    !/^[a-z][a-z0-9_-]{1,31}$/.test(role) ||
    ['admin', 'moderator'].includes(role)
  ) {
    return res
      .status(400)
      .json({
        error: 'That role is reserved or invalid and cannot be edited.',
      });
  }
  const body = req.body || {};
  const prefix = typeof body.prefix === 'string' ? body.prefix.trim() : '';
  const style = typeof body.style === 'string' ? body.style.trim() : '';
  const roleClass = typeof body.class === 'string' ? body.class.trim() : '';
  const priority = Number(body.priority || 0);
  if (
    prefix.length > 32 ||
    roleClass.length > 128 ||
    (roleClass && !/^[a-zA-Z0-9 _-]+$/.test(roleClass)) ||
    !Number.isInteger(priority) ||
    priority < -1000 ||
    priority > 1000
  ) {
    return res
      .status(400)
      .json({
        error: 'Check the prefix, CSS style, class, and priority fields.',
      });
  }
  try {
    const updated = await db.query(
      'UPDATE roles SET prefix = $1, style = $2, class = $3, priority = $4 WHERE role = $5 RETURNING role;',
      [prefix, style, roleClass, priority, role],
    );
    if (!updated.rowCount)
      return res.status(404).json({ error: 'Role not found.' });
    const holders = await db.query(
      'SELECT username FROM users WHERE roles::jsonb ? $1;',
      [role],
    );
    for (const holder of holders.rows) invalidateUserRoleCache(holder.username);
    try {
      await db.query(
        'INSERT INTO mod_logs (mod_username, action_type, reason, timestamp) VALUES ($1, $2, $3, $4);',
        [req.user.username, 'role_edit', role, Date.now()],
      );
    } catch (error) {
      log('Role update audit log failed:', error.message);
    }
    res.json({ success: true, role });
  } catch (error) {
    log('Role update failed:', error.message);
    res
      .status(503)
      .json({ error: 'Database temporarily unavailable. Try again shortly.' });
  }
});

app.post('/api/admin/assign-role', authenticateToken, async (req, res) => {
  if (!hasAdminPrivileges(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  const target = sanitizeUsername(req.body && req.body.target);
  const role =
    typeof (req.body && req.body.role) === 'string'
      ? req.body.role.trim().toLowerCase()
      : '';
  const enabled = req.body && req.body.enabled;
  if (
    !target ||
    !/^[a-z][a-z0-9_-]{1,31}$/.test(role) ||
    (role === 'admin' && enabled !== true) ||
    typeof enabled !== 'boolean'
  ) {
    return res
      .status(400)
      .json({
        error:
          'Choose a valid user and role. The admin role can only be granted.',
      });
  }
  try {
    const userResult = await db.query(
      `SELECT username, roles, is_admin, roles::jsonb @> '["admin"]' AS has_admin_role
       FROM users WHERE LOWER(username) = LOWER($1);`,
      [target],
    );
    if (!userResult.rows[0])
      return res.status(404).json({ error: 'User not found.' });
    if (
      role === 'admin' &&
      (userResult.rows[0].is_admin || userResult.rows[0].has_admin_role)
    )
      return res.status(409).json({ error: 'That user is already an administrator.' });
    if (
      role === 'moderator' &&
      (userResult.rows[0].is_admin || userResult.rows[0].has_admin_role)
    )
      return res.status(400).json({ error: 'Administrator accounts cannot be changed here.' });
    if (role !== 'moderator' && role !== 'admin') {
      const roleResult = await db.query(
        'SELECT role FROM roles WHERE role = $1;',
        [role],
      );
      if (!roleResult.rows[0])
        return res.status(404).json({ error: 'Role not found.' });
    }
    let assignedRoles;
    try {
      assignedRoles = JSON.parse(userResult.rows[0].roles || '[]');
    } catch {
      assignedRoles = [];
    }
    if (!Array.isArray(assignedRoles)) assignedRoles = [];
    assignedRoles = assignedRoles.filter((item) => typeof item === 'string');
    if (role === 'admin')
      assignedRoles = assignedRoles.filter((item) => item !== 'moderator');
    const hasRole = assignedRoles.includes(role);
    if (enabled && !hasRole) assignedRoles.push(role);
    if (!enabled && hasRole)
      assignedRoles = assignedRoles.filter((item) => item !== role);
    if (role === 'moderator') {
      await db.query('UPDATE users SET roles = $1, is_moderator = $2 WHERE username = $3;', [
        JSON.stringify(assignedRoles), enabled, userResult.rows[0].username,
      ]);
    } else if (role === 'admin') {
      await db.query('UPDATE users SET roles = $1, is_admin = true, is_moderator = false WHERE username = $2;', [
        JSON.stringify(assignedRoles), userResult.rows[0].username,
      ]);
    } else {
      await db.query('UPDATE users SET roles = $1 WHERE username = $2;', [
        JSON.stringify(assignedRoles), userResult.rows[0].username,
      ]);
    }
    invalidateUserRoleCache(userResult.rows[0].username);
    await db.query(
      'INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);',
      [
        req.user.username,
        enabled ? 'role_assign' : 'role_remove',
        userResult.rows[0].username,
        role,
        Date.now(),
      ],
    );
    res.json({ success: true, roles: assignedRoles });
  } catch (error) {
    log('Role assignment failed:', error.message);
    res
      .status(503)
      .json({ error: 'Database temporarily unavailable. Try again shortly.' });
  }
});

app.get('/api/admin/removal-proposals', authenticateToken, async (req, res) => {
  if (!hasAdminPrivileges(req.user) && !hasModeratorPrivileges(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  try {
    await db.query(
      `UPDATE admin_removal_proposals p SET status = 'rejected', resolved_at = $1
        WHERE p.status = 'open' AND NOT EXISTS (
          SELECT 1 FROM users u
           WHERE u.username = p.target_username AND ${adminUserSql('u')}
        );`,
      [Date.now()],
    );
    const result = await db.query(
      `SELECT p.id, p.target_username, p.proposed_by, p.eligible_voters,
              p.created_at, p.status,
              COALESCE(json_agg(json_build_object(
                'username', v.voter_username, 'approve', v.approve
              ) ORDER BY v.voter_username) FILTER (WHERE v.voter_username IS NOT NULL), '[]') AS votes
         FROM admin_removal_proposals p
         LEFT JOIN admin_removal_votes v ON v.proposal_id = p.id
        WHERE p.status = 'open'
        GROUP BY p.id
        ORDER BY p.created_at DESC;`,
    );
    const [activeAdminsResult, activeModeratorsResult] = await Promise.all([
      db.query(`SELECT LOWER(u.username) AS username FROM users u WHERE ${adminUserSql('u')};`),
      db.query(`SELECT LOWER(u.username) AS username FROM users u WHERE ${moderatorUserSql('u')};`),
    ]);
    const activeAdmins = new Set(activeAdminsResult.rows.map((row) => row.username));
    const activeModerators = new Set(activeModeratorsResult.rows.map((row) => row.username));
    const viewer = req.user.username.toLowerCase();
    const proposals = result.rows.flatMap((row) => {
      let electorate = { admins: [], moderators: [] };
      try {
        electorate = JSON.parse(row.eligible_voters || '{}');
        if (Array.isArray(electorate)) electorate = { admins: electorate, moderators: [] };
      } catch { }
      const admins = (electorate.admins || []).filter((name) => activeAdmins.has(String(name).toLowerCase()));
      const moderators = (electorate.moderators || []).filter((name) => activeModerators.has(String(name).toLowerCase()));
      const eligibleSet = new Set(admins.concat(moderators).map((name) => String(name).toLowerCase()));
      if (!eligibleSet.has(viewer)) return [];
      const votes = (Array.isArray(row.votes) ? row.votes : []).filter((vote) =>
        eligibleSet.has(String(vote.username).toLowerCase()),
      );
      const yesAdmins = votes.filter((vote) => vote.approve && admins.some((name) => name.toLowerCase() === vote.username.toLowerCase())).length;
      const yesModerators = votes.filter((vote) => vote.approve && moderators.some((name) => name.toLowerCase() === vote.username.toLowerCase())).length;
      return [{
        id: row.id,
        target: row.target_username,
        proposed_by: row.proposed_by,
        created_at: row.created_at,
        eligible_admins: admins.length,
        eligible_moderators: moderators.length,
        threshold_admins: Math.ceil(admins.length * 0.5),
        threshold_moderators: Math.ceil(moderators.length * 0.8),
        yes_admins: yesAdmins,
        yes_moderators: yesModerators,
        my_vote: votes.find((vote) => String(vote.username).toLowerCase() === viewer)?.approve ?? null,
        votes,
      }];
    });
    res.json({ proposals });
  } catch (error) {
    log('Admin removal proposal lookup failed:', error.message);
    res.status(503).json({ error: 'Could not load admin removal votes.' });
  }
});

app.post('/api/admin/removal-proposals', authenticateToken, async (req, res) => {
  if (!hasAdminPrivileges(req.user) && !hasModeratorPrivileges(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  const target = sanitizeUsername(req.body && req.body.target);
  if (!target || !/^[a-z][a-z0-9_-]{1,31}$/i.test(target))
    return res.status(400).json({ error: 'Enter a valid admin username.' });
  if (target.toLowerCase() === req.user.username.toLowerCase())
    return res.status(400).json({ error: 'You cannot propose removing yourself.' });

  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    const targetResult = await client.query(
      `SELECT u.username FROM users u
        WHERE LOWER(u.username) = LOWER($1) AND ${adminUserSql('u')}
        FOR UPDATE;`,
      [target],
    );
    if (!targetResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That user is not an admin.' });
    }
    const targetUsername = targetResult.rows[0].username;
    const voterResult = await client.query(
      `SELECT u.username, ${adminUserSql('u')} AS is_admin,
              ${moderatorUserSql('u')} AS is_moderator
         FROM users u
        WHERE (${adminUserSql('u')} OR ${moderatorUserSql('u')})
          AND LOWER(u.username) <> LOWER($1)
        ORDER BY LOWER(u.username);`,
      [targetUsername],
    );
    const electorate = {
      admins: voterResult.rows.filter((row) => row.is_admin).map((row) => row.username),
      moderators: voterResult.rows.filter((row) => row.is_moderator).map((row) => row.username),
    };
    const eligibleVoters = new Set(electorate.admins.concat(electorate.moderators).map((name) => name.toLowerCase()));
    if (!eligibleVoters.has(req.user.username.toLowerCase())) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only current admins or moderators can propose removals.' });
    }
    const existing = await client.query(
      `SELECT id FROM admin_removal_proposals
        WHERE target_username = $1 AND status = 'open';`,
      [targetUsername],
    );
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'An open removal vote already exists for that admin.' });
    }
    const createdAt = Date.now();
    const proposalResult = await client.query(
      `INSERT INTO admin_removal_proposals
        (target_username, proposed_by, eligible_voters, created_at)
       VALUES ($1, $2, $3, $4) RETURNING id;`,
      [targetUsername, req.user.username, JSON.stringify(electorate), createdAt],
    );
    const proposalId = proposalResult.rows[0].id;
    await client.query(
      `INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp)
       VALUES ($1, 'admin_removal_proposed', $2, $3, $4);`,
      [req.user.username, targetUsername, `Proposal #${proposalId}`, createdAt],
    );
    await client.query('COMMIT');
    res.json({ success: true, proposal_id: proposalId });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => { });
    if (error.code === '23505')
      return res.status(409).json({ error: 'An open removal vote already exists for that admin.' });
    log('Admin removal proposal creation failed:', error.message);
    res.status(503).json({ error: 'Could not create an admin removal vote.' });
  } finally {
    if (client) client.release();
  }
});

app.post('/api/admin/removal-proposals/:id/vote', authenticateToken, async (req, res) => {
  if (!hasAdminPrivileges(req.user) && !hasModeratorPrivileges(req.user))
    return res.status(403).json({ error: 'Unauthorized' });
  const proposalId = Number(req.params.id);
  const approve = req.body && req.body.approve;
  if (!Number.isSafeInteger(proposalId) || proposalId < 1 || typeof approve !== 'boolean')
    return res.status(400).json({ error: 'Choose approve or reject for a valid vote.' });

  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    const proposalResult = await client.query(
      `SELECT id, target_username, eligible_voters, status
         FROM admin_removal_proposals WHERE id = $1 FOR UPDATE;`,
      [proposalId],
    );
    const proposal = proposalResult.rows[0];
    if (!proposal) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Removal vote not found.' });
    }
    if (proposal.status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This removal vote is already closed.' });
    }
    let electorate = { admins: [], moderators: [] };
    try {
      electorate = JSON.parse(proposal.eligible_voters || '{}');
      if (Array.isArray(electorate)) electorate = { admins: electorate, moderators: [] };
    } catch { }
    const voter = req.user.username;
    const targetResult = await client.query(
      `SELECT u.username, u.roles FROM users u
        WHERE u.username = $1 AND ${adminUserSql('u')}
        FOR UPDATE;`,
      [proposal.target_username],
    );
    if (!targetResult.rows[0]) {
      await client.query(
        `UPDATE admin_removal_proposals SET status = 'rejected', resolved_at = $1 WHERE id = $2;`,
        [Date.now(), proposalId],
      );
      await client.query('COMMIT');
      return res.status(409).json({ error: 'The target is no longer an admin; this vote has been closed.' });
    }
    const activeVotersResult = await client.query(
      `SELECT u.username, ${adminUserSql('u')} AS is_admin,
              ${moderatorUserSql('u')} AS is_moderator
         FROM users u
        WHERE (${adminUserSql('u')} OR ${moderatorUserSql('u')})
          AND LOWER(u.username) <> LOWER($1);`,
      [proposal.target_username],
    );
    const activeAdmins = new Set(activeVotersResult.rows.filter((row) => row.is_admin).map((row) => row.username.toLowerCase()));
    const activeModerators = new Set(activeVotersResult.rows.filter((row) => row.is_moderator).map((row) => row.username.toLowerCase()));
    electorate.admins = (electorate.admins || []).filter((name) => activeAdmins.has(String(name).toLowerCase()));
    electorate.moderators = (electorate.moderators || []).filter((name) => activeModerators.has(String(name).toLowerCase()));
    const eligibleVoters = new Set(electorate.admins.concat(electorate.moderators).map((name) => name.toLowerCase()));
    if (!eligibleVoters.has(voter.toLowerCase())) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only current admins or moderators eligible for this proposal can vote.' });
    }
    await client.query(
      'UPDATE admin_removal_proposals SET eligible_voters = $1 WHERE id = $2;',
      [JSON.stringify(electorate), proposalId],
    );
    const voteResult = await client.query(
      `INSERT INTO admin_removal_votes (proposal_id, voter_username, approve, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (proposal_id, voter_username) DO NOTHING;`,
      [proposalId, voter, approve, Date.now()],
    );
    if (!voteResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You have already voted on this proposal.' });
    }
    const tallyResult = await client.query(
      `SELECT voter_username, approve FROM admin_removal_votes WHERE proposal_id = $1;`,
      [proposalId],
    );
    const votes = tallyResult.rows;
    const adminSet = new Set(electorate.admins.map((name) => name.toLowerCase()));
    const moderatorSet = new Set(electorate.moderators.map((name) => name.toLowerCase()));
    const adminVotes = votes.filter((vote) => adminSet.has(vote.voter_username.toLowerCase()));
    const moderatorVotes = votes.filter((vote) => moderatorSet.has(vote.voter_username.toLowerCase()));
    const yesAdmins = adminVotes.filter((vote) => vote.approve).length;
    const yesModerators = moderatorVotes.filter((vote) => vote.approve).length;
    const thresholdAdmins = Math.ceil(electorate.admins.length * 0.5);
    const thresholdModerators = Math.ceil(electorate.moderators.length * 0.8);
    const adminPass = electorate.admins.length > 0 && yesAdmins >= thresholdAdmins;
    const moderatorPass = electorate.moderators.length > 0 && yesModerators >= thresholdModerators;
    let status = 'open';
    if (adminPass || moderatorPass) {
      let roles = [];
      try { roles = JSON.parse(targetResult.rows[0].roles || '[]'); } catch { }
      if (!Array.isArray(roles)) roles = [];
      roles = roles.filter((role) => role !== 'admin');
      await client.query(
        'UPDATE users SET is_admin = false, roles = $1 WHERE username = $2;',
        [JSON.stringify(roles), proposal.target_username],
      );
      status = 'approved';
    } else {
      const adminPossible = yesAdmins + electorate.admins.length - adminVotes.length >= thresholdAdmins;
      const moderatorPossible = yesModerators + electorate.moderators.length - moderatorVotes.length >= thresholdModerators;
      if ((!adminPossible || electorate.admins.length === 0) &&
        (!moderatorPossible || electorate.moderators.length === 0)) status = 'rejected';
    }
    if (status !== 'open') {
      await client.query(
        `UPDATE admin_removal_proposals SET status = $1, resolved_at = $2 WHERE id = $3;`,
        [status, Date.now(), proposalId],
      );
    }
    await client.query(
      `INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp)
       VALUES ($1, 'admin_removal_vote', $2, $3, $4);`,
      [voter, proposal.target_username, `Proposal #${proposalId}: ${approve ? 'approve' : 'reject'} (${status})`, Date.now()],
    );
    await client.query('COMMIT');
    if (status === 'approved') {
      invalidateUserRoleCache(proposal.target_username);
      const targetClient = activeClients.get(proposal.target_username);
      if (targetClient) {
        targetClient.ws.send(JSON.stringify({
          type: 'terminated',
          reason: 'Your administrator access was removed by a vote.',
        }));
        targetClient.ws.close();
        activeClients.delete(proposal.target_username);
        broadcastSystemUpdate(getRosterPayload());
      }
    }
    res.json({ success: true, status, yes_admins: yesAdmins, yes_moderators: yesModerators, threshold_admins: thresholdAdmins, threshold_moderators: thresholdModerators });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => { });
    log('Admin removal vote failed:', error.message);
    res.status(503).json({ error: 'Could not record the admin removal vote.' });
  } finally {
    if (client) client.release();
  }
});

app.post('/api/admin/ban-ip', authenticateToken, async (req, res) => {
  try {
    if (!hasAdminPrivileges(req.user)) {
      return res
        .status(403)
        .json({ error: 'Forbidden: Requires administrator privileges.' });
    }

    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'Missing target IP address.' });
    }

    const reason = "Admin doesn't need any reasons";

    const r = await db.query('SELECT last_ip FROM users WHERE username = $1;', [
      username,
    ]);
    const ip = r.rows[0]?.last_ip;
    if (!ip) {
      return res.status(400).json({ error: 'Missing target IP address.' });
    }

    const checkProtectedIp = await db.query(
      `SELECT username, roles, is_admin, is_bot FROM users WHERE last_ip = $1;`,
      [ip],
    );

    for (const row of checkProtectedIp.rows) {
      const roles = JSON.parse(row.roles || '[]');
      if (
        row.is_bot ||
        row.is_admin ||
        roles.includes('admin')
      ) {
        return res.status(400).json({
          error: `Operation Denied: This IP address is currently used by a protected account (@${row.username}).`,
        });
      }
    }

    await db.query(
      `INSERT INTO banned_ips (ip, banned_by, reason, timestamp) 
       VALUES ($1, $2, $3, $4) ON CONFLICT (ip) DO NOTHING;`,
      [ip, req.user.username, reason, Date.now()],
    );

    await db.query(
      `INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) 
       VALUES ($1, $2, $3, $4, $5);`,
      [req.user.username, 'ip ban', username, reason, Date.now()],
    );

    await db.query('UPDATE users SET is_banned = true WHERE last_ip = $1;', [
      ip,
    ]);

    for (const [username, client] of activeClients.entries()) {
      if (client.lastIp === ip) {
        client.ws.send(
          JSON.stringify({
            type: 'terminate',
            reason: 'Your IP address has been banned.',
          }),
        );
        client.ws.close();
        activeClients.delete(username);
      }
    }

    log(`Blacklisted IP: ${ip} (${username})`);
    return res.status(200).json({
      success: true,
      message: `IP ${ip} banned and corresponding sessions dropped.`,
    });
  } catch (err) {
    log('Admin endpoint /ban-ip failure execution:', err);
    return res.status(500).json({ error: 'Internal system server error.' });
  }
});

app.get('/history', authenticateToken, async (req, res) => {
  log(`history called by ${req.user.username} (${req.user.role.role})`);
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const r = await db.query(
    `SELECT m.*, pi.image_data, json_build_object('role', COALESCE(rr.role, ''), 'prefix', COALESCE(rr.prefix, ''), 'style', COALESCE(rr.style, ''), 'class', COALESCE(rr.class, '')) AS role,
       COALESCE((SELECT json_agg(json_build_object('code', reaction_code, 'count', reaction_count, 'mine', mine)) FROM (SELECT reaction_code, COUNT(*)::int AS reaction_count, BOOL_OR(username = $2) AS mine FROM message_reactions WHERE channel = 'public' AND message_id = m.id GROUP BY reaction_code ORDER BY reaction_code) mr), '[]'::json) AS reactions
       FROM messages m
       LEFT JOIN users u ON m.username = u.username
       LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(m.username) ORDER BY (username = m.username) DESC LIMIT 1) pi ON true
       LEFT JOIN LATERAL (
         SELECT role, prefix, style, class FROM roles
         WHERE role = ANY (SELECT jsonb_array_elements_text(COALESCE(u.roles, '[]')::jsonb))
         ORDER BY CASE WHEN role IN ('admin', 'moderator') THEN 1 ELSE 0 END,
                  priority DESC LIMIT 1
       ) rr ON true
       ORDER BY m.id DESC LIMIT 10 OFFSET $1;`,
    [off, req.user.username],
  );
  res.json(r.rows.reverse());
});

app.get('/dm-history', authenticateToken, async (req, res) => {
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const target = sanitizeUsername(req.query.target);
  const r = await db.query(
    `
    SELECT d.id, d.sender AS username, d.receiver, d.timestamp, d.content, d.is_deleted, d.deleted_by, pi.image_data,
      COALESCE((SELECT json_agg(json_build_object('code', reaction_code, 'count', reaction_count, 'mine', mine)) FROM (SELECT reaction_code, COUNT(*)::int AS reaction_count, BOOL_OR(username = $4) AS mine FROM message_reactions WHERE channel = 'dm' AND message_id = d.id GROUP BY reaction_code ORDER BY reaction_code) mr), '[]'::json) AS reactions
    FROM dms d 
    LEFT JOIN users u ON d.sender = u.username 
    LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(d.sender) ORDER BY (username = d.sender) DESC LIMIT 1) pi ON true
    WHERE (d.sender = $1 AND d.receiver = $2) OR (d.sender = $2 AND d.receiver = $1) 
    ORDER BY d.id DESC LIMIT 10 OFFSET $3;
  `,
    [req.user.username, target, off, req.user.username],
  );
  for (const row of r.rows) row.role = (await getUserRoles(row.username)).role;
  res.json(r.rows.reverse());
});

app.get('/topic-history', authenticateToken, async (req, res) => {
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const slug = sanitize(req.query.slug);
  const r = await db.query(
    `SELECT tm.*, pi.image_data,
      COALESCE((SELECT json_agg(json_build_object('code', reaction_code, 'count', reaction_count, 'mine', mine)) FROM (SELECT reaction_code, COUNT(*)::int AS reaction_count, BOOL_OR(username = $3) AS mine FROM message_reactions WHERE channel = 'topic' AND message_id = tm.id GROUP BY reaction_code ORDER BY reaction_code) mr), '[]'::json) AS reactions
     FROM topic_messages tm LEFT JOIN users u ON tm.username = u.username LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(tm.username) ORDER BY (username = tm.username) DESC LIMIT 1) pi ON true WHERE tm.topic_slug = $1 ORDER BY tm.id DESC LIMIT 10 OFFSET $2;`,
    [slug, off, req.user.username],
  );
  for (const row of r.rows) row.role = (await getUserRoles(row.username)).role;
  res.json(r.rows.reverse());
});

app.get('/neighborhood-history', authenticateToken, async (req, res) => {
  const off = Math.max(0, parseInt(req.query.index ?? '0', 10) * 10);
  const query = `
    SELECT p.*, pi.image_data,
    COALESCE(json_agg(json_build_object('id', c.id, 'username', c.username, 'content', c.content, 'timestamp', c.timestamp, 'is_deleted', c.is_deleted, 'deleted_by', c.deleted_by, 'image_data', ci.image_data, 'is_admin', ${adminUserSql('cu')}, 'is_moderator', ${moderatorUserSql('cu')}) ORDER BY c.id ASC) FILTER (WHERE c.id IS NOT NULL), '[]') as comments
    FROM neighborhood_posts p 
    LEFT JOIN users u ON p.username = u.username
    LEFT JOIN neighborhood_comments c ON p.id = c.post_id 
    LEFT JOIN users cu ON c.username = cu.username
    LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(p.username) ORDER BY (username = p.username) DESC LIMIT 1) pi ON true
    LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(c.username) ORDER BY (username = c.username) DESC LIMIT 1) ci ON true
    GROUP BY p.id, u.id, pi.image_data ORDER BY p.id DESC LIMIT 10 OFFSET $1;`;
  const posts = await db.query(query, [off]);
  let result = [];
  for (let row of posts.rows) {
    row.role = (await getUserRoles(row.username)).role;
    for (let comment of row.comments) {
      comment.role = (await getUserRoles(comment.username)).role;
    }
    result.push(row);
  }
  res.json(result.reverse());
});

const SUGG_MAX_TITLE = 120;
const SUGG_MAX_BODY = 4000;
const SUGG_MAX_FILTER = 200;
const SUGG_MAX_COMMENT = 2000;

function suggClean(value, maxLen) {
  return sanitize(value)
    .replace(/[\u0000-\u001f\u007f]/g, (c) => (c === '\n' ? c : ''))
    .trim()
    .slice(0, maxLen);
}

app.get('/suggestions-history', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(
      30,
      Math.max(1, parseInt(req.query.limit, 10) || 10),
    );
    const off = Math.max(
      0,
      (parseInt(req.query.index ?? '0', 10) || 0) * limit,
    );
    const r = await db.query(
      "SELECT s.id, s.date::text AS date, s.suggestions, s.username, s.admin_filter, s.completion, pi.image_data, COALESCE((SELECT json_agg(json_build_object('id', c.id, 'username', c.username, 'content', c.content, 'created_at', c.created_at) ORDER BY c.id ASC) FROM suggestion_comments c WHERE c.suggestion_id = s.id), '[]'::json) AS comments FROM suggestions s LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(s.username) ORDER BY (username = s.username) DESC LIMIT 1) pi ON true ORDER BY s.id DESC LIMIT $2 OFFSET $1;",
      [off, limit],
    );
    res.json(r.rows.reverse());
  } catch (err) {
    log('Suggestions history failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/suggestions/:id/comments', authenticateToken, async (req, res) => {
  try {
    const blocked = p2dBlockedUser(req.user);
    if (blocked) return res.status(403).json({ error: blocked });
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid suggestion ID.' });
    const content = suggClean(req.body?.content, SUGG_MAX_COMMENT);
    if (!content)
      return res.status(400).json({ error: 'Comment cannot be empty.' });
    const exists = await db.query('SELECT 1 FROM suggestions WHERE id = $1;', [id]);
    if (!exists.rowCount)
      return res.status(404).json({ error: 'No suggestion with that ID.' });
    const result = await db.query(
      'INSERT INTO suggestion_comments (suggestion_id, username, content, created_at) VALUES ($1, $2, $3, $4) RETURNING id;',
      [id, req.user.username, content, Date.now()],
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    log('Suggestion comment failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/suggestions', authenticateToken, async (req, res) => {
  try {
    const blocked = p2dBlockedUser(req.user);
    if (blocked) return res.status(403).json({ error: blocked });
    const title = suggClean(req.body?.title, SUGG_MAX_TITLE);
    const body = suggClean(req.body?.body, SUGG_MAX_BODY);
    if (!title || !body)
      return res
        .status(400)
        .json({ error: 'Title and description are required.' });
    const r = await db.query(
      'INSERT INTO suggestions (date, suggestions, username) VALUES (CURRENT_DATE, $1, $2) RETURNING id;',
      [`${title}\n${body}`, req.user.username],
    );
    log(`Suggestion #${r.rows[0].id} posted by ${req.user.username}`);
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    log('Suggestion post failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.put('/api/suggestions/:id', authenticateToken, async (req, res) => {
  try {
    if (!hasAdminPrivileges(req.user) && !hasModeratorPrivileges(req.user))
      return res.status(403).json({ error: 'Staff only.' });
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid suggestion ID.' });
    const found = await db.query(
      'SELECT admin_filter, completion FROM suggestions WHERE id = $1;',
      [id],
    );
    if (!found.rows[0])
      return res.status(404).json({ error: 'No suggestion with that ID.' });
    const body = req.body || {};
    const touchesFilter = 'admin_filter' in body;
    const touchesCompletion = 'completion' in body;
    if (!touchesFilter && !touchesCompletion)
      return res.status(400).json({ error: 'Nothing to update.' });
    const admin_filter = touchesFilter
      ? suggClean(body.admin_filter ?? '', SUGG_MAX_FILTER) || null
      : found.rows[0].admin_filter;
    let completion = found.rows[0].completion;
    if (touchesCompletion) {
      const v = body.completion;
      completion =
        v === null || v === undefined || v === '' || v === false ? null : true;
    }
    await db.query(
      'UPDATE suggestions SET admin_filter = $1, completion = $2 WHERE id = $3;',
      [admin_filter, completion, id],
    );
    await db.query(
      'INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);',
      [
        req.user.username,
        'suggestion update',
        null,
        id,
        `filter=${admin_filter || ''} completion=${completion === null ? 'unset' : completion}`,
        Date.now(),
      ],
    );
    log(`Suggestion #${id} annotated by ${req.user.username}`);
    res.json({ success: true, id });
  } catch (err) {
    log('Suggestion update failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.delete('/api/suggestions/:id', authenticateToken, async (req, res) => {
  try {
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid suggestion ID.' });
    const r = await db.query(
      'SELECT username FROM suggestions WHERE id = $1;',
      [id],
    );
    if (!r.rows[0])
      return res.status(404).json({ error: 'No suggestion with that ID.' });
    const owner = r.rows[0].username;
    if (owner !== req.user.username && !p2dIsStaff(req.user))
      return res
        .status(403)
        .json({ error: 'You can only delete your own suggestions.' });
    await db.query('DELETE FROM suggestions WHERE id = $1;', [id]);
    if (owner !== req.user.username) {
      await db.query(
        'INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);',
        [
          req.user.username,
          'suggestion delete',
          owner,
          id,
          'Removed suggestion',
          Date.now(),
        ],
      );
    }
    log(`Suggestion #${id} deleted by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    log('Suggestion delete failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

let wikipediaIndex = null
app.get('/api/wikipedia/:page', async (req, res) => {
  let name = req.params.page
  if (typeof name !== 'string' || name.trim() === '') {
    res.status(400).json({
      type: 'wikipedia_error',
      error: 'Invalid page'
    })
    return
  }
  name = name.trim()

  if (!wikipediaIndex) {
    wikipediaIndex = []
    const wikipediaIndexQuery = await db.query('SELECT name FROM wikipedia;')
    for (const row of wikipediaIndexQuery.rows) wikipediaIndex.push(row.name)
    log('loaded wikipedia index:', wikipediaIndex)
  }
  if (wikipediaIndex && wikipediaIndex.includes(name)) {
    const wikipediaQuery = await db.query('SELECT * FROM wikipedia WHERE name = $1;', [name])
    res.status(200).send(wikipediaQuery.rows[0].html)
    return
  }

  log('requesting', `https://en.wikipedia.org/w/rest.php/v1/page/${name}/html`)
  const request = await fetch(`https://en.wikipedia.org/w/rest.php/v1/page/${name}/html`)
  let html = await request.text()
  html = html.replace(
    /(<a\b[^>]*?\bhref\s*=\s*["']?)\.?\/([^\/#?'"]+(?:#[^"']*)?)(["']?)/gi,
    '$1/api/wikipedia/$2$3'
  ) // prefixes all local links with /api/wikipedia
  html = html.replace(
    /<a\b(?=[^>]*\bhref\s*=\s*["'](?:https?:)?\/\/)[^>]*>(.*?)<\/a>/gis,
    '$1'
  ) // strips away all external links
  html = html.replace(
    /<base.*?>(?:<\/base>)?/gi,
    ''
  ) // delete all <base> tags
  html = html.replace(
    /(<link.*?rel\s?=\s?['"]?stylesheet['"]?.*?href\s?=\s?['"]?)(.*?)(['"]?.*?>)/,
    '$1https://en.wikipedia.org/$2$3'
  ) // add external link prefix to the stylesheet URL
  res.status(200).send(html)

  await db.query('INSERT INTO wikipedia (name, html) VALUES ($1, $2);', [name, html])
  wikipediaIndex.push(name)
})

const P2D_CANVAS_W = 640;
const P2D_CANVAS_H = 400;
const P2D_MAX_LEVELS = 30;
const P2D_MAX_PLATFORMS = 150;
const P2D_MAX_HAZARDS = 60;
const P2D_MAX_EXTRAS = 40;
const P2D_MAX_WIRES = 120;
const P2D_MAX_DATA_CHARS = 90000;
const P2D_MAX_DEMO_CHARS = 700000;
const P2D_MAX_DEMO_FRAMES = 1201;
const P2D_MAX_DEMOS_PER_USER = 20;
const P2D_MAX_PACKS_PER_USER = 25;
const P2D_PAGE_SIZE = 10;
const P2D_OFFICIAL = '[official]';
const P2D_OFFICIAL_MAX_LEVELS = 80;
const P2D_OFFICIAL_MAX_CHARS = 400000;

const p2dIsAdmin = (user) =>
  !!(user && user.is_admin);
const p2dIsStaff = (user) => p2dIsAdmin(user) || hasModeratorPrivileges(user);

function p2dName(value, fallback, maxLen) {
  const cleaned = String(value ?? '')
    .replace(/[<>\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

function p2dInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n))
    throw new Error('Level contains a non-numeric value.');
  return Math.min(max, Math.max(min, Math.round(n)));
}

function p2dNum(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n))
    throw new Error('Level contains a non-numeric value.');
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
}

function p2dPoint(o) {
  if (!o || typeof o !== 'object')
    throw new Error('Level is missing a position.');
  return { x: p2dInt(o.x, 0, P2D_CANVAS_W), y: p2dInt(o.y, 0, P2D_CANVAS_H) };
}

function p2dRect(o) {
  const pt = p2dPoint(o);
  return {
    ...pt,
    w: p2dInt(o.w, 1, P2D_CANVAS_W),
    h: p2dInt(o.h, 1, P2D_CANVAS_H),
  };
}

function p2dList(list, max, label, mapper = p2dRect) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error(`Level ${label} must be a list.`);
  if (list.length > max)
    throw new Error(`Too many ${label} in one level (max ${max}).`);
  return list.map(mapper);
}

function p2dLogic(value) {
  return String(value || 'all').toLowerCase() === 'any' ? 'any' : 'all';
}

function p2dLaser(o) {
  if (!o || typeof o !== 'object') throw new Error('Laser is invalid.');
  const pt = p2dPoint(o);
  return {
    ...pt,
    angle: p2dNum(o.angle, -6.283185, 6.283185),
    length: p2dInt(o.length, 1, 900),
    enabled: o.enabled !== false,
  };
}

function p2dWire(o) {
  if (!o || typeof o !== 'object') throw new Error('Wire is invalid.');
  const sourceType = String(o.sourceType || o.source_type || '').toLowerCase();
  const targetType = String(o.targetType || o.target_type || '').toLowerCase();
  if (sourceType !== 'button' && sourceType !== 'trigger')
    throw new Error('Wire source must be a button or trigger.');
  if (targetType !== 'door') throw new Error('Wire target must be a door.');
  return {
    sourceType,
    sourceId: p2dInt(
      o.sourceId !== undefined ? o.sourceId : o.source_id,
      0,
      P2D_MAX_EXTRAS - 1,
    ),
    targetType,
    targetId: p2dInt(
      o.targetId !== undefined ? o.targetId : o.target_id,
      0,
      P2D_MAX_EXTRAS - 1,
    ),
  };
}

function p2dNormalizePack(input, fallbackName, maxLevels = P2D_MAX_LEVELS) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('Pack data is not valid JSON.');
    }
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.levels))
    throw new Error('Pack data must contain a list of levels.');
  if (raw.levels.length < 1)
    throw new Error('A pack needs at least one level.');
  if (raw.levels.length > maxLevels)
    throw new Error(`Too many levels in one pack (max ${maxLevels}).`);

  const levels = raw.levels.map((lvl, i) => {
    if (!lvl || typeof lvl !== 'object')
      throw new Error(`Level ${i + 1} is invalid.`);
    const explicitWires = Array.isArray(lvl.wires);
    const out = {
      name: p2dName(lvl.name, `Level ${i + 1}`, 60),
      start: p2dPoint(lvl.start),
      exit: p2dRect(lvl.exit),
      platforms: p2dList(lvl.platforms, P2D_MAX_PLATFORMS, 'platforms', (p) => {
        const r = p2dRect(p);
        return p && p.metal ? { ...r, metal: true } : r;
      }),
      hazards: p2dList(lvl.hazards, P2D_MAX_HAZARDS, 'hazards'),
      buttons: p2dList(
        Array.isArray(lvl.buttons)
          ? lvl.buttons
          : lvl.button
            ? [lvl.button]
            : [],
        P2D_MAX_EXTRAS,
        'buttons',
        (b) => ({ ...p2dRect(b), pressed: false }),
      ),
      button: lvl.button ? { ...p2dRect(lvl.button), pressed: false } : null,
      triggers: p2dList(lvl.triggers, P2D_MAX_EXTRAS, 'triggers', (t) => ({
        ...p2dRect(t),
        active: false,
      })),
      exitClosed: !!lvl.exitClosed,
      cubeStart: lvl.cubeStart ? p2dRect(lvl.cubeStart) : null,
      noPortal: p2dList(lvl.noPortal, P2D_MAX_EXTRAS, 'no-portal zones'),
      doors: p2dList(lvl.doors, P2D_MAX_EXTRAS, 'doors', (d) => ({
        ...p2dRect(d),
        logic: p2dLogic(d.logic || d.wireMode),
      })),
      wires: p2dList(lvl.wires, P2D_MAX_WIRES, 'wires', p2dWire),
      lasers: p2dList(lvl.lasers, P2D_MAX_EXTRAS, 'lasers', p2dLaser),
      grids: p2dList(lvl.grids, P2D_MAX_EXTRAS, 'grids'),
      plates: p2dList(lvl.plates, P2D_MAX_EXTRAS, 'plates', (p) => ({
        ...p2dRect(p),
        vx: p2dNum(p.vx, -20, 20),
        vy: p2dNum(p.vy, -25, 0),
      })),
    };
    if (!explicitWires && lvl.button && out.doors.length) {
      out.wires = out.doors.map((_, doorId) => ({
        sourceType: 'button',
        sourceId: 0,
        targetType: 'door',
        targetId: doorId,
      }));
    }
    for (const wire of out.wires) {
      const sourceCount =
        wire.sourceType === 'button' ? out.buttons.length : out.triggers.length;
      if (wire.sourceId >= sourceCount)
        throw new Error(
          `Wire ${wire.sourceType} source ${wire.sourceId + 1} does not exist.`,
        );
      if (wire.targetId >= out.doors.length)
        throw new Error(
          `Wire door target ${wire.targetId + 1} does not exist.`,
        );
    }
    if (out.platforms.length < 1)
      throw new Error(`Level ${i + 1} needs at least one platform.`);
    return out;
  });
  return { name: p2dName(raw.name, fallbackName, 100), levels };
}

function p2dParseId(value) {
  if (!/^\d{1,10}$/.test(String(value))) return null;
  const id = parseInt(value, 10);
  return id > 0 && id < 2147483647 ? id : null;
}

function p2dBlockedUser(user) {
  if (user.is_banned) return 'Your account is banned.';
  if (Number(user.timeout_until) > Date.now())
    return 'You are timed out and cannot publish right now.';
  return null;
}

function p2dNormalizeDemo(input, fallbackName) {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('Demo data is invalid JSON.');
    }
  }
  if (!raw || raw.format !== 'unreader.portal.demo' || raw.type !== 'gameplay') {
    throw new Error('This is not a supported UnReader Portal demo.');
  }
  const duration = p2dInt(raw.duration, 1, 120000);
  if (duration < (raw.version === 3 ? 1 : 100)) throw new Error('Demo recording is too short.');
  const levelPack = p2dNormalizePack(
    { name: fallbackName, levels: [raw.level] },
    fallbackName,
    1,
  );
  if (raw.version === 2 || raw.version === 3) {
    const tickBased = raw.version === 3;
    if (!Array.isArray(raw.events) || raw.events.length < 1 || raw.events.length > 5000)
      throw new Error('Demo input timeline is invalid.');
    const allowedKeys = new Set(['a', 'd', 'w', 'arrowleft', 'arrowright', 'arrowup', ' ', 'f']);
    let previousAt = -1;
    const events = raw.events.map((event) => {
      if (!event || typeof event !== 'object') throw new Error('Demo contains an invalid input.');
      const at = p2dInt(tickBased ? event.tick : event.at, 0, duration);
      if (at < previousAt) throw new Error('Demo inputs are out of order.');
      previousAt = at;
      const timing = tickBased ? { tick: at } : { at };
      if (event.type === 'key' && allowedKeys.has(String(event.key).toLowerCase()))
        return { ...timing, type: 'key', key: String(event.key).toLowerCase(), down: !!event.down };
      if (event.type === 'aim')
        return {
          ...timing, type: 'aim',
          x: p2dNum(event.x, -1, 1), y: p2dNum(event.y, -1, 1),
          active: !!event.active, magnitude: p2dNum(event.magnitude, 0, 1),
        };
      if (event.type === 'fire' && (event.color === 'blue' || event.color === 'yellow'))
        return { ...timing, type: 'fire', color: event.color };
      if (event.type === 'restart') return { ...timing, type: 'restart' };
      if (event.type === 'clear' || event.type === 'grab') return { ...timing, type: event.type };
      throw new Error('Demo contains an unsupported input.');
    });
    return {
      format: 'unreader.portal.demo', version: raw.version, type: 'gameplay',
      demoType: 4, duration, level: levelPack.levels[0],
      levelKey: /^p2d-[0-9a-f]{8}$/.test(raw.levelKey || '') ? raw.levelKey : null,
      events,
    };
  }
  if (raw.version !== 1 || !Array.isArray(raw.frames) || raw.frames.length < 2 || raw.frames.length > P2D_MAX_DEMO_FRAMES)
    throw new Error('This is not a supported UnReader Portal demo.');
  const number = (value, min, max, label) => {
    if (!Number.isFinite(Number(value)))
      throw new Error(`Demo ${label} is invalid.`);
    return p2dNum(value, min, max);
  };
  const point = (value, label) => {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object')
      throw new Error(`Demo ${label} is invalid.`);
    return {
      x: number(value.x, -100, P2D_CANVAS_W + 100, `${label} x`),
      y: number(value.y, -100, P2D_CANVAS_H + 100, `${label} y`),
      angle: number(value.angle, -20, 20, `${label} angle`),
      normal: {
        x: number(value.normal?.x, -1, 1, `${label} normal`),
        y: number(value.normal?.y, -1, 1, `${label} normal`),
      },
    };
  };
  let previousAt = -1;
  const frames = raw.frames.map((frame) => {
    if (!frame || typeof frame !== 'object')
      throw new Error('Demo contains an invalid frame.');
    const at = p2dInt(frame.at, 0, duration);
    if (at < previousAt) throw new Error('Demo frames are out of order.');
    previousAt = at;
    if (!frame.player || typeof frame.player !== 'object')
      throw new Error('Demo player state is missing.');
    const player = {
      x: number(frame.player.x, -100, P2D_CANVAS_W + 100, 'player x'),
      y: number(frame.player.y, -100, P2D_CANVAS_H + 100, 'player y'),
      vx: number(frame.player.vx, -100, 100, 'player velocity'),
      vy: number(frame.player.vy, -100, 100, 'player velocity'),
      push: number(frame.player.push || 0, -100, 100, 'player push'),
      lockPush: !!frame.player.lockPush,
      onGround: !!frame.player.onGround,
    };
    const rawAim = frame.aim || { x: 0, y: -1, active: false, magnitude: 0 };
    const aim = {
      x: number(rawAim.x, -1, 1, 'aim x'),
      y: number(rawAim.y, -1, 1, 'aim y'),
      active: !!rawAim.active,
      magnitude: number(rawAim.magnitude || 0, 0, 1, 'aim magnitude'),
    };
    if (!Array.isArray(frame.cubes) || frame.cubes.length > P2D_MAX_EXTRAS)
      throw new Error('Demo cube state is invalid.');
    const cubes = frame.cubes.map((cube) => ({
      x: number(cube.x, -100, P2D_CANVAS_W + 100, 'cube x'),
      y: number(cube.y, -100, P2D_CANVAS_H + 100, 'cube y'),
      w: p2dInt(cube.w, 1, 100, 'cube width'),
      h: p2dInt(cube.h, 1, 100, 'cube height'),
      vx: number(cube.vx || 0, -100, 100, 'cube velocity'),
      vy: number(cube.vy || 0, -100, 100, 'cube velocity'),
    }));
    const boolList = (list, label) => {
      if (!Array.isArray(list) || list.length > P2D_MAX_EXTRAS)
        throw new Error(`Demo ${label} state is invalid.`);
      return list.map(Boolean);
    };
    return {
      at,
      player,
      aim,
      portalA: point(frame.portalA, 'blue portal'),
      portalB: point(frame.portalB, 'orange portal'),
      cubes,
      portalGunStage: p2dInt(frame.portalGunStage, 0, 2),
      levelClear: !!frame.levelClear,
      buttons: boolList(frame.buttons, 'button'),
      triggers: boolList(frame.triggers, 'trigger'),
      laserTriggers: boolList(frame.laserTriggers, 'laser trigger'),
      upgrades: boolList(frame.upgrades, 'upgrade'),
    };
  });
  return {
    format: 'unreader.portal.demo',
    version: 1,
    type: 'gameplay',
    demoType: 4,
    duration,
    level: levelPack.levels[0],
    levelKey: /^p2d-[0-9a-f]{8}$/.test(raw.levelKey || '') ? raw.levelKey : null,
    frames,
  };
}

app.get('/api/portal2d/me', authenticateToken, (req, res) => {
  res.json({
    username: req.user.username,
    isAdmin: p2dIsAdmin(req.user),
    isStaff: p2dIsStaff(req.user),
  });
});

app.get('/api/portal2d/demos', authenticateToken, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, demo_name AS name, 4 AS "demoType", created_at AS "createdAt",
              demo_data::jsonb ->> 'levelKey' AS "levelKey",
              (demo_data::jsonb -> 'level') ->> 'name' AS "levelName"
       FROM portal2d_demos WHERE username = $1 ORDER BY id DESC LIMIT 100;`,
      [req.user.username],
    );
    res.json({ demos: r.rows });
  } catch (err) {
    log('Portal2D demo list failure:', err.message);
    res.status(500).json({ error: 'Could not load saved demos.' });
  }
});

app.get('/api/portal2d/demos/:id', authenticateToken, async (req, res) => {
  try {
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid demo ID.' });
    const r = await db.query(
      `SELECT id, demo_name AS name, demo_data AS data, created_at AS "createdAt"
       FROM portal2d_demos WHERE id = $1 AND username = $2;`,
      [id, req.user.username],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Demo not found.' });
    try {
      r.rows[0].data = JSON.parse(r.rows[0].data);
    } catch {
      return res.status(500).json({ error: 'Stored demo data is corrupted.' });
    }
    res.json(r.rows[0]);
  } catch (err) {
    log('Portal2D demo fetch failure:', err.message);
    res.status(500).json({ error: 'Could not load demo.' });
  }
});

app.post('/api/portal2d/demos', authenticateToken, async (req, res) => {
  try {
    const blocked = p2dBlockedUser(req.user);
    if (blocked) return res.status(403).json({ error: blocked });
    const name = p2dName(req.body?.name, 'Untitled demo', 100);
    let demo;
    try {
      demo = p2dNormalizeDemo(req.body?.data, name);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const json = JSON.stringify(demo);
    if (json.length > P2D_MAX_DEMO_CHARS)
      return res.status(413).json({ error: 'Demo is too large to save.' });
    const count = await db.query(
      'SELECT COUNT(*)::int AS n FROM portal2d_demos WHERE username = $1;',
      [req.user.username],
    );
    if (count.rows[0].n >= P2D_MAX_DEMOS_PER_USER)
      return res.status(400).json({
        error: `You can save up to ${P2D_MAX_DEMOS_PER_USER} demos. Delete one first.`,
      });
    const saved = await db.query(
      `INSERT INTO portal2d_demos (username, demo_name, demo_data, created_at)
       VALUES ($1, $2, $3, $4) RETURNING id;`,
      [req.user.username, name, json, Date.now()],
    );
    res.json({ success: true, id: saved.rows[0].id });
  } catch (err) {
    log('Portal2D demo save failure:', err.message);
    res.status(500).json({ error: 'Could not save demo.' });
  }
});

app.delete('/api/portal2d/demos/:id', authenticateToken, async (req, res) => {
  try {
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid demo ID.' });
    const deleted = await db.query(
      'DELETE FROM portal2d_demos WHERE id = $1 AND username = $2 RETURNING id;',
      [id, req.user.username],
    );
    if (!deleted.rows[0]) return res.status(404).json({ error: 'Demo not found.' });
    res.json({ success: true });
  } catch (err) {
    log('Portal2D demo delete failure:', err.message);
    res.status(500).json({ error: 'Could not delete demo.' });
  }
});

app.get('/api/portal2d/levels', authenticateToken, async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.index ?? '0', 10) || 0);
    const mine = req.query.mine === '1';
    const params = [P2D_PAGE_SIZE + 1, page * P2D_PAGE_SIZE, P2D_OFFICIAL];
    let where = 'WHERE p."username" <> $3';
    if (mine) {
      params.push(req.user.username);
      where += ' AND p."username" = $4';
    }
    const r = await db.query(
      `SELECT p."level-id" AS id, p."level-name" AS name, p."username", pi.image_data
       FROM "portal-2d" p LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(p."username") ORDER BY (username = p."username") DESC LIMIT 1) pi ON true ${where}
       ORDER BY "level-id" DESC LIMIT $1 OFFSET $2;`,
      params,
    );
    const staff = p2dIsStaff(req.user);
    const levels = r.rows.slice(0, P2D_PAGE_SIZE).map((row) => ({
      ...row,
      canDelete: staff || row.username === req.user.username,
      isOwner: row.username === req.user.username,
    }));
    res.json({
      levels,
      hasMore: r.rows.length > P2D_PAGE_SIZE,
      viewer: {
        username: req.user.username,
        isAdmin: p2dIsAdmin(req.user),
        isStaff: staff,
      },
    });
  } catch (err) {
    log('Portal2D list failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/portal2d/levels/:id', authenticateToken, async (req, res) => {
  try {
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid pack ID.' });
    const r = await db.query(
      `SELECT p."level-id" AS id, p."level-name" AS name, p."username", p."level-data" AS data, pi.image_data
       FROM "portal-2d" p LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(p."username") ORDER BY (username = p."username") DESC LIMIT 1) pi ON true WHERE p."level-id" = $1;`,
      [id],
    );
    if (!r.rows[0])
      return res.status(404).json({ error: 'No pack with that ID.' });
    const row = r.rows[0];
    try {
      row.data = JSON.parse(row.data);
    } catch {
      return res.status(500).json({ error: 'Stored pack data is corrupted.' });
    }
    res.json(row);
  } catch (err) {
    log('Portal2D fetch failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/portal2d/levels', authenticateToken, async (req, res) => {
  try {
    const blocked = p2dBlockedUser(req.user);
    if (blocked) return res.status(403).json({ error: blocked });

    const name = p2dName(req.body?.name, 'Untitled pack', 100);
    let pack;
    try {
      pack = p2dNormalizePack(req.body?.data, name);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    pack.name = name;
    const json = JSON.stringify(pack);
    if (json.length > P2D_MAX_DATA_CHARS)
      return res
        .status(413)
        .json({
          error:
            'Pack is too large to publish. Remove some levels or platforms.',
        });

    const count = await db.query(
      'SELECT COUNT(*)::int AS n FROM "portal-2d" WHERE "username" = $1;',
      [req.user.username],
    );
    if (count.rows[0].n >= P2D_MAX_PACKS_PER_USER)
      return res.status(400).json({
        error: `You already have ${P2D_MAX_PACKS_PER_USER} published packs. Delete one first.`,
      });

    const r = await db.query(
      `INSERT INTO "portal-2d" ("level-name", "username", "level-data")
       VALUES ($1, $2, $3) RETURNING "level-id" AS id;`,
      [name, req.user.username, json],
    );
    log(`Portal2D publish: #${r.rows[0].id} "${name}" by ${req.user.username}`);
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) {
    log('Portal2D publish failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.put('/api/portal2d/levels/:id', authenticateToken, async (req, res) => {
  try {
    const blocked = p2dBlockedUser(req.user);
    if (blocked) return res.status(403).json({ error: blocked });
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid pack ID.' });

    const found = await db.query(
      'SELECT "username" FROM "portal-2d" WHERE "level-id" = $1;',
      [id],
    );
    if (!found.rows[0])
      return res.status(404).json({ error: 'No pack with that ID.' });
    if (found.rows[0].username !== req.user.username)
      return res
        .status(403)
        .json({ error: 'You can only update your own packs.' });

    const name = p2dName(req.body?.name, 'Untitled pack', 100);
    let pack;
    try {
      pack = p2dNormalizePack(req.body?.data, name);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    pack.name = name;
    const json = JSON.stringify(pack);
    if (json.length > P2D_MAX_DATA_CHARS)
      return res
        .status(413)
        .json({
          error:
            'Pack is too large to publish. Remove some levels or platforms.',
        });

    await db.query(
      'UPDATE "portal-2d" SET "level-name" = $1, "level-data" = $2 WHERE "level-id" = $3;',
      [name, json, id],
    );
    log(`Portal2D update: #${id} "${name}" by ${req.user.username}`);
    res.json({ success: true, id });
  } catch (err) {
    log('Portal2D update failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.delete('/api/portal2d/levels/:id', authenticateToken, async (req, res) => {
  try {
    const id = p2dParseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid pack ID.' });
    const r = await db.query(
      'SELECT "username" FROM "portal-2d" WHERE "level-id" = $1;',
      [id],
    );
    if (!r.rows[0])
      return res.status(404).json({ error: 'No pack with that ID.' });

    const owner = r.rows[0].username;
    if (owner === P2D_OFFICIAL)
      return res
        .status(403)
        .json({
          error: 'The official pack is managed from the admin dev tools.',
        });
    if (owner !== req.user.username && !p2dIsStaff(req.user))
      return res
        .status(403)
        .json({ error: 'You can only delete your own packs.' });

    await db.query('DELETE FROM "portal-2d" WHERE "level-id" = $1;', [id]);
    if (owner !== req.user.username) {
      await db.query(
        'INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);',
        [
          req.user.username,
          'portal2d delete',
          owner,
          id,
          'Removed published Portal 2D pack',
          Date.now(),
        ],
      );
    }
    log(`Portal2D delete: #${id} by ${req.user.username}`);
    res.json({ success: true });
  } catch (err) {
    log('Portal2D delete failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

async function p2dReadOfficial() {
  const r = await db.query(
    `SELECT "level-id" AS id, "level-name" AS name, "level-data" AS data
     FROM "portal-2d" WHERE "username" = $1 ORDER BY "level-id" ASC LIMIT 1;`,
    [P2D_OFFICIAL],
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return { id: row.id, name: row.name, data: JSON.parse(row.data) };
}

app.get('/api/portal2d/official', authenticateToken, async (req, res) => {
  try {
    const official = await p2dReadOfficial();
    if (!official)
      return res
        .status(404)
        .json({
          error: 'No official pack has been published yet.',
          code: 'NO_OFFICIAL',
        });
    res.json(official);
  } catch (err) {
    log('Portal2D official read failure:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.put('/api/portal2d/official', authenticateToken, async (req, res) => {
  res
    .status(410)
    .json({
      error:
        'Official packs are updated by replacing the exported Portal: The Kindle Version HTML. Use Sledgehammer Editor export.',
    });
});

app.post(
  '/api/portal2d/official/levels',
  authenticateToken,
  async (req, res) => {
    res
      .status(410)
      .json({
        error:
          'Official packs are updated by replacing the exported Portal: The Kindle Version HTML. Use Sledgehammer Editor export.',
      });
  },
);

app.delete('/api/portal2d/official', authenticateToken, async (req, res) => {
  res
    .status(410)
    .json({
      error:
        'Official packs are updated by replacing the exported Portal: The Kindle Version HTML. Use Sledgehammer Editor export.',
    });
});

// Only bind a port when run directly (`node index.js`, e.g. on Render). When
// imported by the Netlify Function, the app is exported instead and the
// WebSocket server stays detached.
const isMainModule =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const server = isMainModule
  ? app.listen(process.env.PORT || 10000, '0.0.0.0', () =>
    log(`Node strictly bound to port: ${process.env.PORT || 10000}`),
  )
  : null;
const wss = server
  ? new WebSocketServer({ server })
  : new WebSocketServer({ noServer: true });

const WS_HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS || 30000);
const heartbeatTimer = setInterval(() => {
  activeClients.forEach((client, username) => {
    if (client.ws.isAlive === false) {
      log(`WS heartbeat timeout: ${username}`);
      activeClients.delete(username);
      return client.ws.terminate();
    }
    client.ws.isAlive = false;
    try {
      client.ws.ping();
    } catch {
      client.ws.terminate();
    }
  });
}, WS_HEARTBEAT_MS);
heartbeatTimer.unref();

const ALLOWED_CHANNELS = {
  public: 'messages',
  topic: 'topic_messages',
  neighborhood: 'neighborhood_posts',
  dm: 'dms',
  comment: 'neighborhood_comments',
  neighborhood_comment: 'neighborhood_comments',
};

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  let authUser = null;
  let userRoles = {
    role: {
      role: '',
      prefix: '',
      style: '',
      class: '',
    },
    is_banned: false,
    timeout_until: 0,
    last_ip: null,
  };

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'auth') {
        try {
          const decoded = jwt.verify(data.token, JWT_SECRET);
          authUser = sanitizeUsername(decoded.username);
          userRoles = await getUserRoles(authUser);
          log(
            `WS Auth Session Established: ${authUser} (Admin: ${userRoles.is_admin}, Mod: ${userRoles.is_moderator})`,
          );
          if (userRoles.is_banned) {
            log(`WS Termination Triggered: Banned or Timed out user session`);
            ws.send(
              JSON.stringify({ type: 'terminated', reason: 'You are banned' }),
            );
            ws.close();
            return;
          }
          if (userRoles.timeout_until > Date.now()) {
            log(`WS Termination Triggered: Banned or Timed out user session`);
            ws.send(
              JSON.stringify({
                type: 'terminated',
                reason: `You are timed out until ${new Date(userRoles.timeout_until).toLocaleString()}`,
              }),
            );
            ws.close();
            return;
          }
          activeClients.set(authUser, {
            ws,
            mode: 'public',
            target: '',
            userRoles: userRoles,
            lastIp: req.socket.remoteAddress,
          });
          const topicsRes = await db.query(
            'SELECT * FROM topics ORDER BY id DESC;',
          );
          ws.send(
            JSON.stringify({
              type: 'topics_update',
              topics: topicsRes.rows,
              user_roles: userRoles,
            }),
          );
          broadcastSystemUpdate(getRosterPayload());
          ws.send(
            JSON.stringify({ type: 'auth_success', userRoles: userRoles }),
          );
        } catch (e) {
          log('WS Authentication Invalid:', e.message);
          ws.send(JSON.stringify({ type: 'terminated' }));
        }
        return;
      }
      if (!authUser) return;

      if (data.type === 'switch_context') {
        const client = activeClients.get(authUser);
        if (client) {
          client.mode = data.mode;
          client.target = data.target;
          broadcastSystemUpdate(getRosterPayload());
        }
        return;
      }

      if (data.type === 'message_reaction') {
        const client = activeClients.get(authUser);
        const channel = client && client.mode;
        const messageId = Number(data.id);
        const reactionCode = Number(data.code);
        const messageTables = {
          public: 'messages',
          dm: 'dms',
          topic: 'topic_messages',
        };
        const table = messageTables[channel];
        if (
          !table ||
          !Number.isInteger(messageId) ||
          messageId < 1 ||
          !Number.isInteger(reactionCode) ||
          reactionCode < 1 ||
          reactionCode > 32767 ||
          (channel !== 'public' &&
            (!client.target || typeof client.target !== 'string'))
        )
          return;

        let messageQuery;
        let messageParams;
        if (channel === 'topic') {
          messageQuery = `SELECT id FROM ${table} WHERE id = $1 AND topic_slug = $2 AND is_deleted = false`;
          messageParams = [messageId, client.target];
        } else if (channel === 'dm') {
          const peer = sanitizeUsername(client.target);
          messageQuery = `SELECT id FROM ${table} WHERE id = $1 AND is_deleted = false AND ((sender = $2 AND receiver = $3) OR (sender = $3 AND receiver = $2))`;
          messageParams = [messageId, authUser, peer];
        } else {
          messageQuery = `SELECT id FROM ${table} WHERE id = $1 AND is_deleted = false`;
          messageParams = [messageId];
        }
        const visibleMessage = await db.query(messageQuery, messageParams);
        if (!visibleMessage.rows.length) return;

        const existing = await db.query(
          'SELECT reaction_code FROM message_reactions WHERE channel = $1 AND message_id = $2 AND username = $3',
          [channel, messageId, authUser],
        );
        if (
          existing.rows[0] &&
          Number(existing.rows[0].reaction_code) === reactionCode
        ) {
          await db.query(
            'DELETE FROM message_reactions WHERE channel = $1 AND message_id = $2 AND username = $3',
            [channel, messageId, authUser],
          );
        } else {
          await db.query(
            `INSERT INTO message_reactions (channel, message_id, username, reaction_code) VALUES ($1, $2, $3, $4)
             ON CONFLICT (channel, message_id, username) DO UPDATE SET reaction_code = EXCLUDED.reaction_code`,
            [channel, messageId, authUser, reactionCode],
          );
        }
        const summary = await db.query(
          'SELECT reaction_code AS code, COUNT(*)::int AS count, BOOL_OR(username = $3) AS mine FROM message_reactions WHERE channel = $1 AND message_id = $2 GROUP BY reaction_code ORDER BY reaction_code',
          [channel, messageId, authUser],
        );
        const reactionUpdate = {
          type: 'message_reactions_update',
          channel,
          target: client.target,
          id: messageId,
          reactions: summary.rows,
        };
        broadcastSystemUpdate(reactionUpdate, (c, username) => {
          if (channel === 'dm') {
            const peer = sanitizeUsername(client.target);
            return (
              c.mode === 'dm' &&
              c.target === (username === authUser ? peer : authUser) &&
              (username === authUser || username === peer)
            );
          }
          return c.mode === channel && c.target === client.target;
        });
        return;
      }

      if (
        [
          'message',
          'topic_message',
          'dm',
          'neighborhood_post',
          'neighborhood_comment',
          'create_topic',
        ].includes(data.type)
      ) {
        log(
          `${data.type} called by ${authUser} (${activeClients.get(authUser).userRoles.role.role}): ${data.content}`,
        );
        const tStr = String(Date.now());
        const mode =
          data.type === 'topic_message'
            ? 'topic'
            : data.type === 'dm'
              ? 'dm'
              : data.type === 'neighborhood_post' ||
                data.type === 'neighborhood_comment'
                ? 'neighborhood'
                : 'public';
        const target = data.target || data.slug || '';

        if (data.type === 'message') {
          const content = sanitize(data.content);
          await db.query(
            'INSERT INTO messages (username, timestamp, content, sender) VALUES ($1, $2, $3, $4);',
            [authUser, tStr, content, authUser],
          );
        }
        if (data.type === 'topic_message') {
          const content = sanitize(data.content);
          const target = sanitize(data.target);
          await db.query(
            'INSERT INTO topic_messages (topic_slug, username, timestamp, content, sender) VALUES ($1, $2, $3, $4, $5);',
            [target, authUser, tStr, content, authUser],
          );
        }
        if (data.type === 'dm') {
          const content = sanitize(data.content);
          const target = sanitizeUsername(data.target);
          await db.query(
            'INSERT INTO dms (sender, receiver, timestamp, content, username) VALUES ($1, $2, $3, $4, $5);',
            [authUser, target, tStr, content, authUser],
          );
        }
        if (data.type === 'neighborhood_post') {
          const title = sanitize(data.title);
          const content = sanitize(data.content);
          await db.query(
            'INSERT INTO neighborhood_posts (username, title, content, timestamp, sender) VALUES ($1, $2, $3, $4, $5);',
            [authUser, title, content, tStr, authUser],
          );
        }
        if (data.type === 'neighborhood_comment') {
          const content = sanitize(data.content);
          const post_id = parseInt(data.post_id, 10);
          await db.query(
            'INSERT INTO neighborhood_comments (post_id, username, content, timestamp, sender) VALUES ($1, $2, $3, $4, $5);',
            [post_id, authUser, content, tStr, authUser],
          );
        }
        if (data.type === 'create_topic') {
          const title = sanitize(data.title);
          const slug = title
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '-')
            .slice(0, 50);
          await db.query(
            'INSERT INTO topics (slug, title, username, timestamp) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING;',
            [slug, title, authUser, tStr],
          );
        }

        let livePayload = null;
        if (data.type === 'message') {
          const role = (await getUserRoles(authUser)).role;
          const latest = await db.query(
            "SELECT m.id, m.username, m.timestamp, m.content, m.is_deleted, m.deleted_by, m.sender, pi.image_data FROM messages m LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(m.username) ORDER BY (username = m.username) DESC LIMIT 1) pi ON true WHERE m.username = $1 AND m.timestamp = $2 ORDER BY m.id DESC LIMIT 1;",
            [authUser, tStr],
          );
          if (latest.rows[0])
            livePayload = {
              type: 'live_message',
              channel: 'public',
              message: { ...latest.rows[0], role },
            };
        } else if (data.type === 'topic_message') {
          const role = (await getUserRoles(authUser)).role;
          const latest = await db.query(
            "SELECT m.id, m.username, m.timestamp, m.content, m.is_deleted, m.deleted_by, m.sender, m.topic_slug, pi.image_data FROM topic_messages m LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(m.username) ORDER BY (username = m.username) DESC LIMIT 1) pi ON true WHERE m.username = $1 AND m.timestamp = $2 AND m.topic_slug = $3 ORDER BY m.id DESC LIMIT 1;",
            [authUser, tStr, target],
          );
          if (latest.rows[0])
            livePayload = {
              type: 'live_message',
              channel: 'topic',
              target,
              message: { ...latest.rows[0], role },
            };
        } else if (data.type === 'dm') {
          const role = (await getUserRoles(authUser)).role;
          const latest = await db.query(
            "SELECT d.id, d.sender AS username, d.receiver, d.timestamp, d.content, d.is_deleted, d.deleted_by, pi.image_data FROM dms d LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(d.sender) ORDER BY (username = d.sender) DESC LIMIT 1) pi ON true WHERE d.sender = $1 AND d.receiver = $2 AND d.timestamp = $3 ORDER BY d.id DESC LIMIT 1;",
            [authUser, target, tStr],
          );
          if (latest.rows[0])
            livePayload = {
              type: 'live_message',
              channel: 'dm',
              target,
              receiver: target,
              sender: authUser,
              message: { ...latest.rows[0], role },
            };
        } else if (data.type === 'neighborhood_post') {
          const role = (await getUserRoles(authUser)).role;
          const latest = await db.query(
            "SELECT p.id, p.username, p.title, p.content, p.timestamp, p.is_deleted, p.deleted_by, p.sender, pi.image_data FROM neighborhood_posts p LEFT JOIN LATERAL (SELECT image_data FROM profile_images WHERE LOWER(TRIM(LEADING '@' FROM username)) = LOWER(p.username) ORDER BY (username = p.username) DESC LIMIT 1) pi ON true WHERE p.username = $1 AND p.timestamp = $2 ORDER BY p.id DESC LIMIT 1;",
            [authUser, tStr],
          );
          if (latest.rows[0])
            livePayload = {
              type: 'live_neighborhood_post',
              message: { ...latest.rows[0], role, comments: [] },
            };
        }

        if (livePayload) {
          broadcastSystemUpdate(livePayload, (c, username) => {
            if (mode === 'dm') {
              return (
                c.mode === 'dm' &&
                c.target === (username === authUser ? target : authUser) &&
                (username === authUser || username === target)
              );
            }
            return c.mode === mode && c.target === target;
          });
        } else if (data.type === 'neighborhood_comment') {
          broadcastSystemUpdate(
            { type: 'refresh_feed' },
            (c) => c.mode === 'neighborhood',
          );
        }
      }

      if (data.type === 'mod_delete' || data.type === 'mod_restore') {
        const targetTable = ALLOWED_CHANNELS[data.channel];
        log(
          `MOD PACKET: action=${data.type}, targetSpace=${data.channel}, table=${targetTable}, id=${data.id}`,
        );

        if (!targetTable) {
          log(
            `CRITICAL: Infrastructure target space undefined for channel ${data.channel}`,
          );
          return;
        }

        const res = await db.query(
          `SELECT username, sender, deleted_by FROM ${targetTable} WHERE id = $1;`,
          [data.id],
        );
        const targetObj = res.rows[0];
        if (!targetObj) {
          log(`CRITICAL: ID ${data.id} not tracked in ${targetTable}`);
          return;
        }
        const owner = targetObj.username || targetObj.sender;
        if (!owner) {
          log(`CRITICAL: Owner not found for ID ${data.id} in ${targetTable}`);
          return;
        }

        const isOwner = owner === authUser;
        const canUndo =
          hasAdminPrivileges(userRoles) ||
          (hasModeratorPrivileges(userRoles) &&
            targetObj.deleted_by === authUser);
        const canDelete =
          isOwner ||
          hasAdminPrivileges(userRoles) ||
          hasModeratorPrivileges(userRoles);

        if (data.type === 'mod_delete' && canDelete) {
          const reason =
            data.reason ||
            (hasAdminPrivileges(userRoles)
              ? "Admin doesn't need any reasons"
              : sanitize('No reason provided'));
          log(
            `EXECUTING DATA PURGE: targetId=${data.id} in ${targetTable} by=${authUser}`,
          );
          await db.query(
            `UPDATE ${targetTable} SET is_deleted = true, deleted_by = $1 WHERE id = $2;`,
            [authUser, data.id],
          );
          if (
            hasModeratorPrivileges(userRoles) ||
            hasAdminPrivileges(userRoles)
          ) {
            await db.query(
              'INSERT INTO mod_logs (mod_username, action_type, target_username, target_id, reason, timestamp) VALUES ($1, $2, $3, $4, $5, $6);',
              [authUser, 'delete', owner, data.id, reason, Date.now()],
            );
          }
          broadcastSystemUpdate({ type: 'refresh_feed' });
        } else if (data.type === 'mod_restore' && canUndo) {
          log(
            `EXECUTING DATA RESTORE: targetId=${data.id} in ${targetTable} by=${authUser}`,
          );
          await db.query(
            `UPDATE ${targetTable} SET is_deleted = false, deleted_by = NULL WHERE id = $1;`,
            [data.id],
          );
          broadcastSystemUpdate({ type: 'refresh_feed' });
        } else {
          log(
            `MOD ACTION REJECTED: Access level mismatch or ownership collision`,
          );
        }
      }

      if (data.type === 'scrshare_send') {
        if (screenshares[authUser])
          clearTimeout(screenshares[authUser].endTimer);
        else broadcastSystemUpdate(getRosterPayload())
        screenshares[authUser] = {
          frame: data.frame,
          endTimer: setTimeout(() => {
            screenshares[authUser] = null
            broadcastSystemUpdate(getRosterPayload())
          }, 2000),
        };
      }

      if (data.type === 'scrshare_receive') {
        if (screenshares[data.sender]) {
          ws.send(JSON.stringify({
            type: 'scrshare_frame',
            frame: screenshares[data.sender].frame,
            sender: data.sender
          }))
        } else {
          ws.send(JSON.stringify({
            type: 'scrshare_error',
            error: 'The selected user is not sharing their screen.'
          }))
        }
      }

      if (hasAdminPrivileges(userRoles) || hasModeratorPrivileges(userRoles)) {
        if (data.type === 'mod_timeout') {
          const target = sanitizeUsername(data.target);
          const targetRoles = await getUserRoles(target);
          if (hasAdminPrivileges(targetRoles))
            return ws.send(
              JSON.stringify({
                type: 'error_alert',
                message: 'System operator immunity detected.',
              }),
            );
          const duration = Math.min(
            Math.max(1, parseInt(data.duration, 10)),
            43200,
          );
          const reason =
            sanitize(data.reason || '') ||
            (hasAdminPrivileges(userRoles)
              ? "Admin doesn't need any reasons"
              : sanitize('No reason provided'));
          log(
            `USER TIMEOUT: target=${target}, duration=${duration}m, by=${authUser}`,
          );
          await db.query(
            'UPDATE users SET timeout_until = $1 WHERE username = $2;',
            [Date.now() + duration * 60 * 1000, target],
          );
          await db.query(
            'INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);',
            [authUser, 'timeout', target, reason, Date.now()],
          );
          if (activeClients.has(target)) {
            activeClients.get(target).ws.send(
              JSON.stringify({
                type: 'terminated',
                reason: 'You were timed out by a moderator.',
              }),
            );
            activeClients.get(target).ws.close();
          }
        }
        if (data.type === 'mod_kick') {
          if (!activeClients.has(data.target))
            return log(`KICK TARGET ${data.target} NOT CONNECTED`, data.target);
          const targetRoles = await getUserRoles(data.target);
          if (
            hasAdminPrivileges(userRoles) ||
            (hasModeratorPrivileges(userRoles) &&
              !hasAdminPrivileges(targetRoles) &&
              data.target !== authUser)
          ) {
            const client = activeClients.get(data.target);
            const reason =
              data.reason ||
              (hasAdminPrivileges(userRoles)
                ? "Admin doesn't need any reasons"
                : sanitize('No reason provided'));
            client.ws.send(
              JSON.stringify({
                type: 'terminated',
                reason: 'You were kicked by a moderator.',
              }),
            );
            client.ws.close();
            activeClients.delete(data.target);
            broadcastSystemUpdate(getRosterPayload());
            await db.query(
              'INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);',
              [authUser, 'kick', data.target, reason, Date.now()],
            );
          }
        }
        if (hasAdminPrivileges(userRoles)) {
          if (data.type === 'mod_ban') {
            const target = sanitizeUsername(data.target);
            const reason =
              sanitize(data.reason || '') || "Admin doesn't need any reasons";
            log(`ADMIN BAN: target=${target}, by=${authUser}`);
            await db.query(
              'UPDATE users SET is_banned = true WHERE username = $1;',
              [target],
            );
            await db.query(
              'INSERT INTO mod_logs (mod_username, action_type, target_username, reason, timestamp) VALUES ($1, $2, $3, $4, $5);',
              [authUser, 'ban', target, reason, Date.now()],
            );
            if (activeClients.has(target)) {
              activeClients.get(target).ws.send(
                JSON.stringify({
                  type: 'terminated',
                  reason: 'You were banned by a moderator.',
                }),
              );
              activeClients.get(target).ws.close();
            }
          }
          if (data.type === 'mod_pardon') {
            const target = sanitizeUsername(data.target);
            log(`ADMIN PARDON: target=${target}, by=${authUser}`);
            await db.query(
              'UPDATE users SET is_banned = false, timeout_until = 0 WHERE username = $1;',
              [target],
            );
          }
        }
      }
    } catch (err) {
      log('WS Infrastructure Logic Failure:', err.message);
    }
  });
  ws.on('close', () => {
    if (authUser) {
      log(`WS Terminal closed: ${authUser}`);
      if (activeClients.get(authUser)?.ws === ws) {
        activeClients.delete(authUser);
        broadcastSystemUpdate(getRosterPayload());
      }
    }
  });
});

export { app, databaseReady };
