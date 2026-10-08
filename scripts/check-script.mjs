#!/usr/bin/env node
// 脚本模式（script.json）的断言。假 Fish 跑的是 scripts/mock-tts.js（子进程），
// 时间戳不可用时的退路用一个只会普通合成的假服务测。
//
// 跑法：node scripts/check-script.mjs
//
// 覆盖：
//   1. 解析：script.json / {script, answer_key} 打包；不合并同一人的连续句
//   2. 送给 TTS 的文本：tts_text、被打断句子的续接（去掉行尾逗号）
//   3. 逐词时间戳定位：按比例落到词上、在词内插值、忽略标点和 [标签]
//   4. 排期：after 按说话区间算、during 落在 at_text 上、显式 ref 越过附和、
//      被打断的句子在截止点淡出、不压音量、同设备重叠告警、引用不存在时的退路
//   5. 导入：answer key 跟着进房间、meta → 房间设置、实体 → glossary
//   6. 合成：走带时间戳的接口，快照「替换」不「追加」；没要过时间戳的缓存算没好
//   7. 时间戳接口不可用时退回普通接口，房间照样能开
//   8. 接口：/timeline 的 JSON / TXT / RTTM，/answer-key
//   9. 开播：真实的 socket.io 服务端和客户端，脚本房间的时间线下发、落库、从中间开始

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'script-'));
process.env.FISH_API_KEY = 'mock-key-for-local-testing-only';

const here = path.dirname(fileURLToPath(import.meta.url));
const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- 假 Fish：mock-tts.js 子进程
const mockPort = await freePort();
const mock = spawn(process.execPath, [path.join(here, 'mock-tts.js')], {
  env: { ...process.env, MOCK_TTS_PORT: String(mockPort) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('mock-tts did not start')), 8000);
  mock.stdout.on('data', (d) => {
    if (String(d).includes(String(mockPort))) {
      clearTimeout(timer);
      resolve();
    }
  });
});
const MOCK_URL = `http://127.0.0.1:${mockPort}`;
process.env.FISH_BASE_URL = MOCK_URL;

const { parseTranscript } = await import('../server/parse.js');
const script = await import('../server/script.js');
const { buildSchedule } = await import('../server/schedule.js');
const rooms = await import('../server/rooms.js');
const { importTranscript, planImport } = await import('../server/importer.js');
const { ensureAudio, lookupAudio, parseAlignment } = await import('../server/tts.js');
const { db } = await import('../server/db.js');
const { createApiRouter } = await import('../server/api.js');
const { attachRealtime } = await import('../server/realtime.js');
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

const SCRIPT = {
  meta: {
    source_file: 'Demo-Inventory-3-Participants-Chaotic-Airport.md',
    title: '库存同步',
    language: 'zh-CN',
    style: 'chaotic',
    environment: 'airport',
    target_minutes: 25,
  },
  speakers: [
    { id: 'S1', display_name: '周明远', role: '后端', l1: 'zh', voice: { gender: 'male', locale: 'zh-CN' } },
    { id: 'S2', display_name: '沈嘉禾', role: '产品', l1: 'zh', voice: { gender: 'female', locale: 'zh-CN' } },
    { id: 'S3', display_name: '何一帆', role: '数据', l1: 'zh', voice: { gender: 'male', locale: 'zh-CN' } },
  ],
  utterances: [
    { id: 'u1', speaker: 'S1', type: 'speech', text: '库存同步昨晚慢了40分钟。', tts_text: '库存同步昨晚慢了四十分钟。', clean: '库存同步昨晚慢了40分钟。', timing: { mode: 'after', ref: null, gap_ms: 0 } },
    { id: 'u2', speaker: 'S1', type: 'speech', text: '前台显示有货，仓里已经没了。', clean: '前台显示有货，仓里已经没了。', timing: { mode: 'after', ref: 'u1', gap_ms: 600 } },
    { id: 'u3', speaker: 'S2', type: 'backchannel', text: '嗯。', clean: '', timing: { mode: 'during', ref: 'u2', at_text: '显示有货', delay_ms: 0 } },
    { id: 'u4', speaker: 'S2', type: 'speech', text: '那超卖了多少单？', clean: '那超卖了多少单？', timing: { mode: 'after', ref: 'u2', gap_ms: 400 } },
    { id: 'u5', speaker: 'S2', type: 'speech', text: '那这个得赶紧跟，', tts_continuation: '客服说一下', cut_off: true, clean: '那这个得赶紧跟', timing: { mode: 'after', ref: 'u4', gap_ms: 300 } },
    { id: 'u6', speaker: 'S1', type: 'speech', text: '不是不是，等一帆拉完数据再说。', clean: '不是，等一帆拉完数据再说。', timing: { mode: 'during', ref: 'u5', at_text: '那这个得', delay_ms: 0 } },
    { id: 'u7', speaker: 'S3', type: 'nonspeech', event: 'chuckle', text: '', tts_text: '[chuckling]', clean: '', timing: { mode: 'after', ref: 'u6', gap_ms: 200 } },
    { id: 'u8', speaker: 'S3', type: 'speech', text: '我3点前给你。', tts_text: '我三点前给你。', clean: '我3点前给你。', timing: { mode: 'after', gap_ms: 300 } },
  ],
};
const ANSWER_KEY = {
  decisions: [],
  entities: [
    { id: 'E1', canonical: '何一帆', forms: ['一帆'], type: 'person', evidence: ['u6'] },
    { id: 'E2', canonical: '40分钟', forms: ['40分钟'], type: 'number', evidence: ['u1'] },
    { id: 'E3', canonical: 'Kafka', forms: ['Kafka'], type: 'product', evidence: ['u1'] },
  ],
  summary_reference: '库存同步慢了40分钟。',
};

/** parseScript 的结果 → 跟 getLines() 一样形状的行（snake_case、timing 是 JSON 串） */
const toRows = (parsed) =>
  parsed.lines.map((l, idx) => ({
    idx,
    speaker: l.speaker,
    content: l.content,
    uid: l.uid,
    kind: l.kind,
    tts_text: l.ttsText,
    tts_continuation: l.ttsContinuation,
    timing: l.timing ? JSON.stringify(l.timing) : null,
    cut_off: l.cutOff ? 1 : 0,
    clean: l.clean,
  }));

// 合成的对齐：开口前 150ms 静音，每个字 200ms，说完后 250ms 静音
const LEAD = 150;
const PER = 200;
const TAIL = 250;
function fakeAudio(row, i) {
  const full = script.ttsInputOf(row);
  const chars = [...script.normForAlign(full)];
  const words = chars.map((c, k) => ({ t: c, s: LEAD + k * PER, e: LEAD + (k + 1) * PER }));
  const speechEnd = words.length ? words[words.length - 1].e : LEAD;
  return {
    hash: `h${i}`,
    durationMs: speechEnd + TAIL,
    alignment: words.length ? { speechStartMs: LEAD, speechEndMs: speechEnd, words } : { unavailable: true },
  };
}

// ---------------------------------------------------------------- 1
console.log('\n1) 解析 script.json');
const parsed = parseTranscript(JSON.stringify(SCRIPT, null, 2));
{
  t('认成 script 格式', parsed.format === 'script', parsed.format);
  t('8 条全收，同一人的连续句不合并', parsed.lines.length === 8 && parsed.lines[0].speaker === parsed.lines[1].speaker);
  t('说话人用 display_name，顺序同 speakers', parsed.speakers.join() === '周明远,沈嘉禾,何一帆', parsed.speakers.join());
  t('非语言声音没有参考文本、保留 tts_text', parsed.lines[6].content === '' && parsed.lines[6].ttsText === '[chuckling]');
  t('续接只留在 cut_off 的行上', parsed.lines[4].ttsContinuation === '客服说一下' && parsed.lines[4].cutOff);
  t('timing 归一化：during 带 at_text、after 带 gap_ms', parsed.lines[2].timing.at_text === '显示有货' && parsed.lines[1].timing.gap_ms === 600);
  t('没写 ref 的 timing 不凭空补一个 ref', !('ref' in parsed.lines[7].timing));

  const bundle = parseTranscript(JSON.stringify({ script: SCRIPT, answer_key: ANSWER_KEY }));
  t('{script, answer_key} 打包也认，answer key 带上', bundle.format === 'script' && bundle.script.answerKey?.entities?.length === 3);

  const broken = parseTranscript(JSON.stringify({ ...SCRIPT, utterances: [...SCRIPT.utterances, { id: 'u9', type: 'speech', text: '谁说的' }] }));
  t('没有说话人的条目跳过并告警', broken.lines.length === 8 && broken.warnings.some((w) => w.includes('u9')));

  t('普通 JSON 台词数组照旧（不是脚本）', parseTranscript('[{"speaker":"A","content":"hi"},{"speaker":"B","content":"yo"}]').format === 'json');
}

// ---------------------------------------------------------------- 2
console.log('\n2) 送给 TTS 的文本');
{
  const rows = toRows(parsed);
  t('有 tts_text 用 tts_text', script.ttsInputOf(rows[0]) === '库存同步昨晚慢了四十分钟。');
  t('被打断的中文句：去掉行尾逗号、续接不加空格', script.ttsInputOf(rows[4]) === '那这个得赶紧跟客服说一下', script.ttsInputOf(rows[4]));
  t('英文续接加空格', script.ttsInputOf({ content: 'We should, ', cut_off: 1, tts_continuation: 'maybe wait' }) === 'We should maybe wait');
  t('没 cut_off 就不拼续接', script.ttsInputOf({ content: 'Fine.', cut_off: 0, tts_continuation: 'x' }) === 'Fine.');
  t('普通房间的行就是 content（音频哈希和以前一样）', script.ttsInputOf({ content: 'hello there' }) === 'hello there');
}

// ---------------------------------------------------------------- 3
console.log('\n3) 逐词时间戳定位');
{
  const a = { speechStartMs: 100, speechEndMs: 1300, words: [{ t: '前台', s: 100, e: 500 }, { t: '显示', s: 500, e: 900 }, { t: '有货', s: 900, e: 1300 }] };
  t('念到「前台显示」= 第二个词的结尾', script.locateInClip(a, '前台显示有货', '前台显示', 1500) === 900);
  t('落在词中间就在词内插值', script.locateInClip(a, '前台显示有货', '前台显', 1500) === 700);
  t('标点和 [标签] 不占位置', script.locateInClip(a, '前台，[break]显示有货。', '前台，[break]显示', 1500) === 900);
  t('没有时间戳时按比例落在整段上', script.locateInClip(null, '前台显示有货', '前台显示', 1500) === 1000);
  t('接口说不可用时也按比例', script.locateInClip({ unavailable: true }, 'abcd', 'ab', 800) === 400);
}

// ---------------------------------------------------------------- 4
console.log('\n4) 排期');
const room = { script_mode: 1, gap_ms: 450, duck_gain: 0.5 };
const rows = toRows(parsed);
const devices = { 周明远: 'dA', 沈嘉禾: 'dB', 何一帆: 'dC' };
const speakerMap = (dev) => new Map(Object.keys(dev).map((n) => [n, { name: n, device_id: dev[n], volume: 100 }]));
const audioMap = new Map(rows.map((r, i) => [r.idx, fakeAudio(r, i)]));
{
  const { items, warnings, overlaps } = buildSchedule(room, rows, speakerMap(devices), audioMap, null);
  const by = Object.fromEntries(items.map((i) => [i.uid, i]));
  const speechStart = (it) => it.startMs + it.speechStartMs;
  const speechEnd = (it) => it.startMs + it.speechEndMs;

  t('8 条都排上了', items.length === 8);
  t('时间线从 0 开始（第一句的前导静音被平移掉）', Math.min(...items.map((i) => i.startMs)) === 0 && by.u1.startMs === 0);
  t('按开口先后排序', items.every((it, i) => i === 0 || items[i - 1].startMs <= it.startMs));
  t('after：按说话区间算间隔（不是文件边界）', speechStart(by.u2) === speechEnd(by.u1) + 600, `${speechStart(by.u2)} vs ${speechEnd(by.u1) + 600}`);
  // u2 = 前台显示有货仓里已经没了（12 个字），「显示有货」在第 6 个字结束
  t('during：附和落在 at_text 念完的那一刻', speechStart(by.u3) === by.u2.startMs + LEAD + 6 * PER, `${speechStart(by.u3)}`);
  t('显式 ref 越过附和，接在主说话人后面', speechStart(by.u4) === speechEnd(by.u2) + 400);
  // u5 合成的是「那这个得赶紧跟客服说一下」（12 字），text 部分 7 个字
  t('被打断的句子：说话区间到 text 的最后一个字', by.u5.speechEndMs === LEAD + 7 * PER, String(by.u5.speechEndMs));
  t('被打断的句子：截止点 = 说完 + 淡出，后面的续接不播', by.u5.stopAtMs === by.u5.speechEndMs + 80 && by.u5.durationMs === by.u5.stopAtMs);
  t('打断的人落在「那这个得」上', speechStart(by.u6) === by.u5.startMs + LEAD + 4 * PER);
  t('没写 ref 的 after 接在列表上一条（笑声）之后', speechStart(by.u8) === speechEnd(by.u7) + 300);
  t('附和和打断都标成重叠，正常接话不算', by.u3.overlapMs > 0 && by.u6.overlapMs > 0 && by.u4.overlapMs === 0 && overlaps >= 2);
  t('脚本房间不压音量', items.every((i) => i.duckFromMs === null));
  t('各自一台设备时没有同设备重叠告警', warnings.sameDeviceOverlaps.length === 0);

  const shared = buildSchedule(room, rows, speakerMap({ 周明远: 'dA', 沈嘉禾: 'dA', 何一帆: 'dC' }), audioMap, null);
  t('重叠的两个人分在同一台设备上会告警', shared.warnings.sameDeviceOverlaps.length >= 1, JSON.stringify(shared.warnings));

  const noAlign = new Map([...audioMap].map(([k, v]) => [k, { ...v, alignment: null }]));
  const fallback = buildSchedule(room, rows, speakerMap(devices), noAlign, null);
  t('没有时间戳也能排（按比例估）', fallback.items.length === 8 && fallback.items.find((i) => i.uid === 'u3').overlapMs > 0);

  const badRows = rows.map((r) => (r.uid === 'u4' ? { ...r, timing: JSON.stringify({ mode: 'after', ref: 'nope', gap_ms: 400 }) } : r));
  const bad = buildSchedule(room, badRows, speakerMap(devices), audioMap, null);
  t('ref 指向不存在的条目：记告警、退回接在上一条后面', bad.warnings.unresolvedRefs.includes('u4'));

  const plain = buildSchedule({ order_mode: 'ordered', gap_ms: 450 }, rows.slice(0, 2), speakerMap(devices), audioMap, null);
  t('普通房间还是老排法（文件边界 + gap）', plain.items[1].startMs === plain.items[0].durationMs + 450);
}

// ---------------------------------------------------------------- 5
console.log('\n5) 导入');
let scriptRoomId;
let scriptHostToken;
{
  const res = importTranscript(
    { name: 'Demo.script.json', text: JSON.stringify(SCRIPT), answerKey: JSON.stringify(ANSWER_KEY) },
    { ownerId: null }
  );
  scriptRoomId = res.id;
  scriptHostToken = res.hostToken;
  const roomRow = rooms.getRoom(res.id);
  t('导入成功并标成脚本房间', res.ok && res.scriptMode && res.hasAnswerKey && roomRow.script_mode === 1);
  t('answer key 原样进了房间', rooms.getAnswerKey(res.id)?.summary_reference === ANSWER_KEY.summary_reference);
  t('meta.style / environment → 无序 + 机场', roomRow.order_mode === 'chaotic' && roomRow.noise_mode === 'noisy' && roomRow.ambience_kind === 'airport');
  const gl = String(roomRow.glossary || '').split('\n');
  t('人名、产品名进 glossary，数字不进', gl.includes('何一帆') && gl.includes('一帆') && gl.includes('Kafka') && !gl.includes('40分钟'), roomRow.glossary);
  const lines = rooms.getLines(res.id);
  t('行的 uid / kind / tts_text / timing 都存下来了', lines[2].uid === 'u3' && lines[2].kind === 'backchannel' && lines[0].tts_text === '库存同步昨晚慢了四十分钟。' && JSON.parse(lines[5].timing).mode === 'during');
  t('参考转写只含有文字的行', !rooms.referenceTranscript(res.id).includes('chuckling') && rooms.referenceTranscript(res.id).split('\n').length === 7);
  t('房间名带上主题', String(res.title).startsWith('库存同步'), res.title);
  t('房间状态告诉前端这是脚本房间', rooms.roomState(res.id).scriptMode === true && rooms.roomState(res.id).hasAnswerKey === true);

  const noKey = planImport({ name: 'x.script.json', text: JSON.stringify(SCRIPT), answerKey: '{oops' });
  t('answer key 坏了：照常导入并告警', noKey.scriptMode && noKey.warnings.some((w) => w.includes('answer_key')) && !noKey.parsed.script.answerKey);

  const wrongCount = planImport({ name: 'x.script.json', text: JSON.stringify({ ...SCRIPT, meta: { ...SCRIPT.meta, source_file: 'A-4-Participants-Orderly.md' } }) });
  t('文件名里的人数对不上会告警', wrongCount.warnings.some((w) => w.includes('4 participants')));
  t('普通 transcript 的导入不受影响', planImport({ name: 'en_sync_2p_ordered.txt', text: 'Alice: hi\nBob: hello' }).parsed.format !== 'script');
}

// ---------------------------------------------------------------- 6
console.log('\n6) 合成：带时间戳的接口');
{
  const targets = rooms.lineTargets(scriptRoomId);
  t('脚本房间要逐词时间戳', targets.every((x) => x.withAlignment));
  t('被打断的句子按「text + 续接」算哈希', targets[4].ttsInput === '那这个得赶紧跟客服说一下');
  t('合成前进度是 0', rooms.generationProgress(scriptRoomId).ready === 0);

  for (const x of targets) {
    await ensureAudio({ model: x.model, voice: x.voice, instructions: x.instructions, speed: x.speed, text: x.ttsInput, withAlignment: true });
  }
  const p = rooms.generationProgress(scriptRoomId);
  t('全部合成好', p.ready === p.total && p.total === 8, JSON.stringify(p));

  const a = parseAlignment(lookupAudio(targets[1].hash).alignment);
  // 前台显示有货仓里已经没了 = 12 个字。快照分三次来，「追加」的话会变成 4+8+12 = 24 个
  t('快照是替换不是追加', a?.words?.length === 12, String(a?.words?.length));
  t('开口时间是前导静音之后', a.speechStartMs === 150 && a.speechEndMs > a.speechStartMs);

  // 同一句话先被普通房间合成过（没有时间戳）：脚本房间算没好，要重合成
  db.prepare('UPDATE audio SET alignment = NULL WHERE hash = ?').run(targets[0].hash);
  t('缓存里有音频但没要过时间戳 → 算没好', rooms.generationProgress(scriptRoomId).mask[0] === 0);
  const again = await ensureAudio({ model: targets[0].model, voice: targets[0].voice, instructions: targets[0].instructions, speed: targets[0].speed, text: targets[0].ttsInput, withAlignment: true });
  t('重合成后补上时间戳', !again.cached && again.alignment?.words?.length > 0 && rooms.generationProgress(scriptRoomId).mask[0] === 1);

  const sse = [
    { audio_base64: Buffer.from('AAA').toString('base64'), chunk_seq: 0, chunk_audio_offset_sec: 0, alignment: { segments: [{ text: 'Hello', start: 0, end: 0.4 }] } },
    { audio_base64: Buffer.from('BBB').toString('base64'), chunk_seq: 0, chunk_audio_offset_sec: 0, alignment: { segments: [{ text: 'Hello', start: 0, end: 0.4 }, { text: 'world', start: 0.4, end: 0.9 }] } },
    { audio_base64: Buffer.from('CCC').toString('base64'), chunk_seq: 1, chunk_audio_offset_sec: 2, alignment: { segments: [{ text: 'Again', start: 0.1, end: 0.5 }] } },
    { audio_base64: Buffer.from('DDD').toString('base64'), chunk_seq: 1, chunk_audio_offset_sec: 2, alignment: null },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const parsedSse = script.parseTimestampStream(sse);
  const merged = script.alignmentFromSnapshots(parsedSse.snapshots, 3);
  t('SSE：音频块按顺序拼起来', parsedSse.buffer.toString() === 'AAABBBCCCDDD');
  t('SSE：同一 chunk_seq 取最新快照，跨 chunk 加上偏移', merged.words.length === 3 && merged.words[2].s === 2100 && merged.speechEndMs === 2500);
}

// ---------------------------------------------------------------- 7
console.log('\n7) 时间戳接口不可用时的退路');
{
  const silent = Buffer.alloc(417 * 40);
  for (let i = 0; i < 40; i++) silent.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  const plainFish = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url.startsWith('/v1/tts/stream/with-timestamp')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Not Found' }));
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(silent);
    });
  });
  await new Promise((r) => plainFish.listen(0, '127.0.0.1', r));
  process.env.FISH_BASE_URL = `http://127.0.0.1:${plainFish.address().port}`;
  const got = await ensureAudio({ model: 's2.1-pro-free', voice: 'v-x', instructions: '', speed: 1, text: '只会普通合成的接口', withAlignment: true });
  t('退回普通接口照样拿到音频', got.durationMs > 0 && !got.cached);
  t('记成「要过但没有」，不会每次都重试', got.alignment?.unavailable === true && lookupAudio(got.hash).alignment != null);
  const hit = await ensureAudio({ model: 's2.1-pro-free', voice: 'v-x', instructions: '', speed: 1, text: '只会普通合成的接口', withAlignment: true });
  t('第二次直接命中缓存', hit.cached);
  process.env.FISH_BASE_URL = MOCK_URL;
  plainFish.close();
}

// ---------------------------------------------------------------- 8
console.log('\n8) 接口：时间线和 answer key');
{
  const app = express();
  const server = http.createServer(app);
  app.use('/api', createApiRouter({ broadcast: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const j = await (await fetch(`${base}/api/rooms/${scriptRoomId}/timeline`)).json();
  t('没播过也能现排一份（标成 played:false）', j.played === false && j.scriptMode === true && j.lines.length === 8);
  const cut = j.lines.find((l) => l.uid === 'u5');
  t('被打断的句子：逐词时间里没有续接的词', cut.words.length === 7 && cut.words.every((w) => w.endMs <= cut.endMs), String(cut.words.length));
  t('每句话的说话区间单调、在台词顺序附近', j.lines.every((l) => l.endMs > l.startMs));
  const txt = await (await fetch(`${base}/api/rooms/${scriptRoomId}/timeline?format=txt`)).text();
  t('TXT：带时间戳的参考转写，非语言声音不进', txt.split('\n').length === 7 && /^\[00:00\.\d\] 周明远: 库存同步昨晚慢了40分钟。/.test(txt), txt.split('\n')[0]);
  const rttm = await (await fetch(`${base}/api/rooms/${scriptRoomId}/timeline?format=rttm`)).text();
  t('RTTM：每句一行', rttm.split('\n').length === 7 && rttm.startsWith(`SPEAKER ${scriptRoomId} 1 `));

  rooms.saveTimeline(scriptRoomId, { startedAt: 1, fromIdx: null, scriptMode: true, items: j.lines.slice(0, 2).map((l) => ({ idx: l.idx, uid: l.uid, kind: l.kind, speaker: l.speaker, hash: rooms.lineTargets(scriptRoomId)[l.idx].hash, startMs: l.clipStartMs, durationMs: 1000, speechStartMs: l.startMs - l.clipStartMs, speechEndMs: l.endMs - l.clipStartMs })) });
  const saved = await (await fetch(`${base}/api/rooms/${scriptRoomId}/timeline`)).json();
  t('播过就以实际播出来的时间线为准', saved.played === true && saved.lines.length === 2);

  const key = await fetch(`${base}/api/rooms/${scriptRoomId}/answer-key`);
  t('/answer-key 返回导入的 answer key', key.ok && (await key.json()).entities.length === 3);
  const { id: plainId } = rooms.createRoom({ title: 'plain' });
  rooms.setTranscript(plainId, { speakers: ['A'], lines: [{ speaker: 'A', content: 'hi' }] });
  t('普通房间没有 answer key → 404', (await fetch(`${base}/api/rooms/${plainId}/answer-key`)).status === 404);
  t('普通房间没合成、没播过 → 409', (await fetch(`${base}/api/rooms/${plainId}/timeline`)).status === 409);
  server.close();
}

// ---------------------------------------------------------------- 9
console.log('\n9) 开播');
{
  rooms.saveTimeline(scriptRoomId, null); // 清掉上一节手工存的
  const server = http.createServer();
  attachRealtime(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const open = (deviceId, hostToken) =>
    new Promise((resolve, reject) => {
      const sock = connect(url, {
        path: '/socket.io',
        transports: ['websocket'],
        reconnection: false,
        auth: { roomId: scriptRoomId, deviceId, deviceName: deviceId, hostToken },
      });
      const events = [];
      sock.onAny((name, payload) => events.push({ name, payload }));
      sock.once('hello', () => resolve({ s: sock, events }));
      sock.once('fatal', (e) => reject(new Error(e.message)));
      sock.once('connect_error', reject);
    });
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  const host = await open('host', scriptHostToken);
  const other = await open('r2');
  for (const d of [host, other]) d.s.on('play:prepare', (p) => d.s.emit('play:ready', { token: p.token }));
  await settle();

  host.s.emit('room:start');
  await settle(1800); // 预加载握手 + GO_LEAD_MS
  const prep = host.events.find((e) => e.name === 'play:prepare')?.payload;
  t('开播时下发脚本排出来的时间线', prep?.items?.length === 8, JSON.stringify(prep?.items?.length));
  const cutItem = prep?.items.find((i) => i.uid === 'u5');
  t('被打断的句子带着截止点下发', cutItem?.stopAtMs > 0 && cutItem.durationMs === cutItem.stopAtMs);
  t('下发的时间线按开口先后排好、不压音量', prep.items.every((it, i) => (i === 0 || prep.items[i - 1].startMs <= it.startMs) && it.duckFromMs === null));
  t('go 之后实际时间线落库', rooms.getSavedTimeline(scriptRoomId)?.items?.length === 8);

  const u6 = rooms.getLines(scriptRoomId).find((l) => l.uid === 'u6');
  host.events.length = 0;
  host.s.emit('room:start', { fromIdx: u6.idx });
  await settle(400);
  const from = host.events.find((e) => e.name === 'play:prepare')?.payload;
  t('从中间某一句开始：那一句在 0，没有负的开口时间', from?.items?.[0]?.idx === u6.idx && from.items.every((i) => i.startMs >= 0));

  host.s.emit('room:stop');
  await settle(150);
  host.s.close();
  other.s.close();
  server.close();
}

mock.kill();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
