// 账号体系：Google 登录（OAuth 2.0 授权码流程，服务端换 token）。
//
// 游客不需要登录就能进房间、被分配角色、当收音设备。只有「建房」「导入 transcript」
// 需要登录 —— 房间归属到账号上，换台电脑登录同一个 Google 账号还是房主。
//
// 流程：
//   GET /api/auth/google?next=/room/ABC   → 跳 Google 的授权页（带随机 state，存 cookie 防 CSRF）
//   GET /api/auth/google/callback          → 校验 state，用 code 换 id_token，建 / 更新用户，
//                                            发一个 HttpOnly 的会话 cookie，跳回 next
//   GET /api/auth/me                       → 当前登录的用户（游客为 null）
//   POST /api/auth/logout                  → 删掉会话
//
// 环境变量：
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   Google Cloud Console 里建的 Web application 客户端
//   PUBLIC_URL                                可选。回调地址的域名，不填就按请求头推
//                                             （Railway 等反代会带 x-forwarded-proto / host）
//   ALLOWED_EMAIL_DOMAINS                     可选。逗号分隔，比如 zoom.us —— 只允许这些域的账号登录

import crypto from 'node:crypto';
import express from 'express';
import { db } from './db.js';

const SESSION_COOKIE = 'rr_session';
const STATE_COOKIE = 'rr_oauth_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
// 可覆盖，只为了测试时指到本地的假 Google
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';

const clientId = () => process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET || '';

export function authConfigured() {
  return Boolean(clientId() && clientSecret());
}

/**
 * 建房 / 导入要不要登录。配了 Google 就要；生产环境没配也要（宁可建不了房，也别让
 * 谁都能建）。本地开发没配就放开，免得跑起来还得先去 Google 建客户端。
 */
export function authRequired() {
  return authConfigured() || process.env.NODE_ENV === 'production';
}

const allowedDomains = () =>
  String(process.env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

/* ------------------------------------------------------------------ */
/* cookie / 会话                                                        */
/* ------------------------------------------------------------------ */

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function isHttps(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.startsWith('https://');
  return req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
}

function setCookie(res, req, name, value, maxAgeMs) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function publicUser(row) {
  return row ? { id: row.id, email: row.email, name: row.name, picture: row.picture } : null;
}

/** 从 Cookie 头里找出当前用户；过期或不存在返回 null。HTTP 和 socket 握手都用它 */
export function userFromCookieHeader(header) {
  const token = parseCookies(header)[SESSION_COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, Date.now());
  return publicUser(row);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    now,
    now + SESSION_TTL_MS
  );
  return token;
}

export function upsertUser({ id, email, name, picture }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, email, name, picture, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name,
       picture = excluded.picture, last_login = excluded.last_login`
  ).run(id, email, name || null, picture || null, now, now);
}

/** 给 express 用：把 req.user 填上（游客为 null） */
export function attachUser(req, _res, next) {
  req.user = userFromCookieHeader(req.get('cookie'));
  next();
}

/** 建房 / 导入：要求登录（authRequired() 为假时放行） */
export function requireLogin(req, res, next) {
  if (!authRequired() || req.user) return next();
  res.status(401).json({
    error: authConfigured()
      ? 'Sign in with Google to do that'
      : 'Google sign-in is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)',
    needLogin: true,
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

function callbackUrl(req) {
  const base =
    process.env.PUBLIC_URL?.replace(/\/$/, '') ||
    `${isHttps(req) ? 'https' : 'http'}://${String(req.get('x-forwarded-host') || req.get('host')).split(',')[0].trim()}`;
  return `${base}/api/auth/google/callback`;
}

/** 只允许站内相对路径，防止被当成开放跳转 */
function safeNext(raw) {
  const v = String(raw || '/');
  return v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

/** id_token 的 payload。token 是我们用 client secret 直接从 Google 换来的（TLS），签名不再重复校验 */
function decodeIdToken(idToken) {
  const part = String(idToken || '').split('.')[1];
  if (!part) throw new Error('Google returned no id_token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export function createAuthRouter() {
  const router = express.Router();

  router.get('/me', attachUser, (req, res) => {
    res.json({ user: req.user, configured: authConfigured(), required: authRequired() });
  });

  router.get('/google', (req, res) => {
    if (!authConfigured()) {
      return res.redirect(`/?authError=${encodeURIComponent('Google sign-in is not configured on this server')}`);
    }
    const state = crypto.randomBytes(16).toString('hex');
    const next = safeNext(req.query.next);
    setCookie(res, req, STATE_COOKIE, `${state}|${next}`, 10 * 60 * 1000);
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', clientId());
    url.searchParams.set('redirect_uri', callbackUrl(req));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    res.redirect(url.toString());
  });

  router.get('/google/callback', async (req, res) => {
    const fail = (msg) => res.redirect(`/?authError=${encodeURIComponent(msg)}`);
    const [state, next] = String(parseCookies(req.get('cookie'))[STATE_COOKIE] || '').split('|');
    setCookie(res, req, STATE_COOKIE, '', 0);

    if (req.query.error) return fail(`Google sign-in was cancelled (${req.query.error})`);
    if (!state || state !== req.query.state) return fail('Sign-in expired or was tampered with — try again');
    if (!req.query.code) return fail('Google returned no authorization code');

    try {
      const r = await fetch(TOKEN_URL(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code),
          client_id: clientId(),
          client_secret: clientSecret(),
          redirect_uri: callbackUrl(req),
          grant_type: 'authorization_code',
        }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error_description || body.error || `token exchange failed (${r.status})`);

      const claims = decodeIdToken(body.id_token);
      if (claims.aud !== clientId()) throw new Error('id_token was issued for a different client');
      if (!claims.sub || !claims.email) throw new Error('Google returned no account id / email');
      if (claims.email_verified === false) throw new Error('That Google account email is not verified');

      const domains = allowedDomains();
      const domain = String(claims.email).split('@')[1]?.toLowerCase();
      if (domains.length && !domains.includes(domain)) {
        return fail(`Only ${domains.map((d) => '@' + d).join(', ')} accounts can sign in`);
      }

      upsertUser({ id: claims.sub, email: claims.email, name: claims.name, picture: claims.picture });
      setCookie(res, req, SESSION_COOKIE, createSession(claims.sub), SESSION_TTL_MS);
      res.redirect(safeNext(next));
    } catch (err) {
      fail(`Google sign-in failed: ${err.message || err}`);
    }
  });

  router.post('/logout', (req, res) => {
    const token = parseCookies(req.get('cookie'))[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    setCookie(res, req, SESSION_COOKIE, '', 0);
    res.json({ ok: true });
  });

  return router;
}
