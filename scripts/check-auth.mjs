#!/usr/bin/env node
// 账号体系的断言：真实的 express + socket.io，Google 的 token 接口换成本地假服务。
//
// 跑法：node scripts/check-auth.mjs
//
// 钉住的行为：
//   - 游客：能加入房间（socket 连得上），但不能建房、不能批量导入
//   - Google 登录：state 防 CSRF、换 token、发会话 cookie、跳回 next
//   - 建房人登录后在任何设备上都是房主（不需要本机 host token）
//   - 账号体系之前建的房间可以用 host token 认领
//   - ALLOWED_EMAIL_DOMAINS 限制登录的域
//   - 退出登录后会话失效

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

// ---- 假 Google：按 code 返回不同的账号 ----
const accounts = {
  alice: { sub: 'g-alice', email: 'alice@zoom.us', name: 'Alice', email_verified: true },
  bob: { sub: 'g-bob', email: 'bob@zoom.us', name: 'Bob', email_verified: true },
  eve: { sub: 'g-eve', email: 'eve@gmail.com', name: 'Eve', email_verified: true },
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeGoogle = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const p = new URLSearchParams(body);
    const acct = accounts[p.get('code')];
    res.setHeader('content-type', 'application/json');
    if (!acct || p.get('client_secret') !== 'test-secret') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'invalid_grant' }));
    }
    const idToken = `${b64({ alg: 'none' })}.${b64({ ...acct, aud: process.env.GOOGLE_CLIENT_ID, iss: 'https://accounts.google.com' })}.sig`;
    res.end(JSON.stringify({ access_token: 'x', id_token: idToken }));
  });
});
await new Promise((r) => fakeGoogle.listen(0, '127.0.0.1', r));
process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${fakeGoogle.address().port}/token`;

const { createAuthRouter } = await import('../server/auth.js');
const { createApiRouter } = await import('../server/api.js');
const { attachRealtime } = await import('../server/realtime.js');
const rooms = await import('../server/rooms.js');
const { io: connect } = await import('socket.io-client');

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

const app = express();
const server = http.createServer(app);
const { broadcast } = attachRealtime(server);
app.use('/api/auth', createAuthRouter());
app.use('/api', createApiRouter({ broadcast }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const req = (p, { method = 'GET', cookie, body } = {}) =>
  fetch(base + p, {
    method,
    redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const cookieFrom = (res, name) =>
  (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);

/** 走一遍完整的登录流程，返回会话 cookie（或者失败时的跳转地址） */
async function login(code, next = '/room/ABC') {
  const start = await req(`/api/auth/google?next=${encodeURIComponent(next)}`);
  const loc = new URL(start.headers.get('location'));
  const stateCookie = cookieFrom(start, 'rr_oauth_state');
  const cb = await req(`/api/auth/google/callback?code=${code}&state=${loc.searchParams.get('state')}`, {
    cookie: stateCookie,
  });
  return { start, loc, cb, session: cookieFrom(cb, 'rr_session') };
}

// ---------------------------------------------------------------- 1
console.log('\n1) 游客');
{
  const me = await (await req('/api/auth/me')).json();
  t('游客 /me 返回 user=null，并告诉前端需要登录', me.user === null && me.required === true && me.configured === true);
  const create = await req('/api/rooms', { method: 'POST', body: { title: 'x' } });
  t('★ 游客不能建房（401 needLogin）', create.status === 401 && (await create.json()).needLogin === true);
  const imp = await req('/api/rooms/import', { method: 'POST', body: { files: [{ name: 'a.txt', text: 'A: hi\nB: yo' }] } });
  t('★ 游客不能批量导入', imp.status === 401);
}

// ---------------------------------------------------------------- 2
console.log('\n2) Google 登录');
let alice;
{
  const { start, loc, cb, session } = await login('alice', '/room/ABC');
  t('跳到 Google 授权页，带 client_id 和回调地址', start.status === 302 && loc.host === 'accounts.google.com' &&
    loc.searchParams.get('client_id') === process.env.GOOGLE_CLIENT_ID &&
    loc.searchParams.get('redirect_uri') === `${base}/api/auth/google/callback`);
  t('回调后发了会话 cookie，跳回 next', Boolean(session) && cb.headers.get('location') === '/room/ABC',
    cb.headers.get('location'));
  alice = session;
  const me = await (await req('/api/auth/me', { cookie: alice })).json();
  t('/me 返回登录的账号', me.user?.email === 'alice@zoom.us' && me.user?.id === 'g-alice');

  const startBad = await req('/api/auth/google');
  const bad = await req(`/api/auth/google/callback?code=alice&state=forged`, { cookie: cookieFrom(startBad, 'rr_oauth_state') });
  t('★ state 对不上 → 拒绝，不发会话', /authError=/.test(bad.headers.get('location')) && !cookieFrom(bad, 'rr_session'));

  const evil = await req(`/api/auth/google?next=${encodeURIComponent('https://evil.example')}`);
  const st = new URL(evil.headers.get('location')).searchParams.get('state');
  const cb2 = await req(`/api/auth/google/callback?code=bob&state=${st}`, { cookie: cookieFrom(evil, 'rr_oauth_state') });
  t('next 只允许站内路径（防开放跳转）', cb2.headers.get('location') === '/', cb2.headers.get('location'));
}

// ---------------------------------------------------------------- 3
console.log('\n3) 登录后建房 / 房主身份');
let roomId;
{
  const create = await req('/api/rooms', { method: 'POST', cookie: alice, body: { title: 'Alice room' } });
  const body = await create.json();
  roomId = body.id;
  t('登录后能建房', create.ok && roomId);
  t('房间归属到账号上', rooms.getRoom(roomId).owner_id === 'g-alice');

  const imp = await req('/api/rooms/import', { method: 'POST', cookie: alice, body: { files: [{ name: 'en_sync_2_ordered.txt', text: 'A: hi there\nB: hello you' }] } });
  const imported = (await imp.json()).results?.[0];
  t('登录后能批量导入，导入的房间也归她', imported?.ok && rooms.getRoom(imported.id).owner_id === 'g-alice');

  const mine = await (await req('/api/rooms/mine', { cookie: alice })).json();
  t('/rooms/mine 列出账号名下的房间，带 host token', mine.rooms.length === 2 && mine.rooms.every((r) => r.hostToken));

  const rename = await req(`/api/rooms/${roomId}`, { method: 'PATCH', cookie: alice, body: { title: 'renamed' } });
  t('★ 没有本机 host token，凭账号也能改房间名', rename.ok);

  const { session: bob } = await login('bob');
  const bobRename = await req(`/api/rooms/${roomId}`, { method: 'PATCH', cookie: bob, body: { title: 'hijack' } });
  t('★ 别的账号不是房主', bobRename.status === 403);

  // socket：建房人换台设备（没有 host token）连进来也是房主；游客照样能加入
  const hello = (cookie) =>
    new Promise((resolve, reject) => {
      const s = connect(base, {
        path: '/socket.io',
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: cookie ? { cookie } : {},
        auth: { roomId, deviceId: `dev-${Math.random()}`, deviceName: 'x' },
      });
      s.once('hello', (p) => {
        s.close();
        resolve(p);
      });
      s.once('connect_error', reject);
    });
  t('★ 建房人在另一台设备上登录 → socket 里是房主', (await hello(alice)).isHost === true);
  t('别的账号 → 不是房主', (await hello(bob)).isHost === false);
  t('游客也能加入房间（不是房主）', (await hello(null)).isHost === false);
}

// ---------------------------------------------------------------- 4
console.log('\n4) 认领账号体系之前建的房间');
{
  const legacy = rooms.createRoom({ title: 'old room' });
  const wrong = await (await req('/api/rooms/claim', { method: 'POST', cookie: alice, body: { rooms: [{ id: legacy.id, hostToken: 'nope' }] } })).json();
  t('token 不对 → 不认领', wrong.claimed === 0 && rooms.getRoom(legacy.id).owner_id === null);
  const ok = await (await req('/api/rooms/claim', { method: 'POST', cookie: alice, body: { rooms: [{ id: legacy.id, hostToken: legacy.hostToken }] } })).json();
  t('★ 拿着 host token → 认领到账号上', ok.claimed === 1 && rooms.getRoom(legacy.id).owner_id === 'g-alice');
  const { session: bob } = await login('bob');
  const again = await (await req('/api/rooms/claim', { method: 'POST', cookie: bob, body: { rooms: [{ id: legacy.id, hostToken: legacy.hostToken }] } })).json();
  t('已经有主人的房间不会被别人再认领', again.claimed === 0 && rooms.getRoom(legacy.id).owner_id === 'g-alice');
}

// ---------------------------------------------------------------- 5
console.log('\n5) 限制登录的邮箱域 / 退出登录');
{
  process.env.ALLOWED_EMAIL_DOMAINS = 'zoom.us';
  const { cb, session } = await login('eve');
  t('★ 不在允许的域里 → 拒绝登录', !session && /authError=/.test(cb.headers.get('location')));
  const { session: ok } = await login('bob');
  t('允许的域照常登录', Boolean(ok));
  delete process.env.ALLOWED_EMAIL_DOMAINS;

  await req('/api/auth/logout', { method: 'POST', cookie: alice });
  const me = await (await req('/api/auth/me', { cookie: alice })).json();
  t('★ 退出后会话失效', me.user === null);
}

server.close();
fakeGoogle.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
