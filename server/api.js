import express from 'express';
import fs from 'node:fs';
import { audioPath } from './db.js';
import { parseTranscript } from './parse.js';
import { voices, countries, DIMENSIONS } from './voices.js';
import { attachUser, requireLogin } from './auth.js';
import {
  createRoom,
  getRoom,
  isRoomHost,
  ownedRooms,
  claimRooms,
  setTranscript,
  getLines,
  roomState,
  renameRoom,
  deleteRoom,
  roomSummaries,
  TITLE_MAX_WEIGHT,
} from './rooms.js';
import { jobStatus } from './generate.js';
import { apiKeyProblem, TTS_MODELS, DEFAULT_TTS_MODEL } from './tts.js';
import { PRODUCTS, apiKeyProblem as judgeKeyProblem } from './judge.js';
import { EVAL_MODEL } from './llm.js';
import {
  MAX_REPORT_ROOMS,
  allowedRoomIds,
  createReport,
  listReports,
  getReport,
  deleteReport,
  reportMarkdown,
  reportCsv,
} from './report.js';
import { importTranscript, MAX_IMPORT_FILES, MAX_IMPORT_FILE_BYTES } from './importer.js';

const HASH_RE = /^[a-f0-9]{32}$/;

export function createApiRouter({ broadcast }) {
  const router = express.Router();

  router.use(express.json({ limit: '12mb' }));
  router.use(express.text({ limit: '12mb', type: 'text/plain' }));
  router.use(attachUser);

  const requireRoom = (req, res, next) => {
    const room = getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    req.room = room;
    next();
  };

  const requireHost = (req, res, next) => {
    const token = req.get('x-host-token');
    if (!isRoomHost(req.room, { token, userId: req.user?.id })) {
      return res.status(403).json({ error: 'Only the host can do that' });
    }
    next();
  };

  // 音色 / 维度目录，前端用来渲染下拉框
  router.get('/meta', (_req, res) => {
    const problem = apiKeyProblem();
    res.json({
      voices: voices(),
      dimensions: DIMENSIONS,
      models: TTS_MODELS,
      defaultModel: DEFAULT_TTS_MODEL,
      countries: countries(),
      titleMaxWeight: TITLE_MAX_WEIGHT,
      ttsConfigured: !problem,
      ttsProblem: problem,
      compare: {
        products: PRODUCTS,
        problem: judgeKeyProblem(),
        // 唯一的判定模型：抽参考、判 UER、判摘要都用它；所有分数由代码算
        model: EVAL_MODEL(),
      },
    });
  });

  // 建房要登录（游客只能加入别人的房间）
  router.post('/rooms', requireLogin, (req, res) => {
    const { id, hostToken } = createRoom({ title: req.body?.title, ownerId: req.user?.id ?? null });
    res.json({ id, hostToken });
  });

  // 当前账号名下的全部房间，带 host token
  router.get('/rooms/mine', requireLogin, (req, res) => {
    res.json({ rooms: req.user ? ownedRooms(req.user.id) : [] });
  });

  // 把本机存着 host token、还没有主人的老房间认到当前账号上
  router.post('/rooms/claim', requireLogin, (req, res) => {
    res.json({ claimed: req.user ? claimRooms(req.user.id, req.body?.rooms) : 0 });
  });

  // 批量导入：每个 transcript 文件建一个房间，按文件里的要求配好（不合成音频）。
  // 前端会把最多 100 个文件按体积分批发过来；单个文件失败不影响其它文件。
  router.post('/rooms/import', requireLogin, (req, res) => {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) return res.status(400).json({ error: 'No files' });
    if (files.length > MAX_IMPORT_FILES) {
      return res.status(400).json({ error: `At most ${MAX_IMPORT_FILES} files at a time` });
    }
    const results = files.map((f) => {
      const name = String(f?.name || 'transcript.txt').slice(0, 200);
      const text = String(f?.text ?? '');
      if (Buffer.byteLength(text) > MAX_IMPORT_FILE_BYTES) {
        return { file: name, ok: false, error: 'File is over 4MB' };
      }
      try {
        return importTranscript({ name, text }, { ownerId: req.user?.id ?? null });
      } catch (err) {
        return { file: name, ok: false, error: err.message || String(err) };
      }
    });
    res.json({ results });
  });

  // ---------------- 综合报告 ----------------
  // 报告属于生成它的账号；只能选自己的房间（最多 1000 个）
  router.get('/reports', requireLogin, (req, res) => {
    res.json({ reports: listReports(req.user?.id ?? null), maxRooms: MAX_REPORT_ROOMS });
  });

  router.post('/reports', requireLogin, (req, res) => {
    const requested = Array.isArray(req.body?.roomIds) ? req.body.roomIds : [];
    if (requested.length > MAX_REPORT_ROOMS) {
      return res.status(400).json({ error: `At most ${MAX_REPORT_ROOMS} rooms per report` });
    }
    const roomIds = allowedRoomIds(requested, req.user?.id ?? null);
    try {
      const id = createReport({
        ownerId: req.user?.id ?? null,
        roomIds,
        title: req.body?.title,
        scoreMissing: req.body?.scoreMissing === true,
      });
      res.json({ id, rooms: roomIds.length, skipped: requested.length - roomIds.length });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/reports/:rid', requireLogin, (req, res) => {
    const report = getReport(req.params.rid, req.user?.id ?? null);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json({ report });
  });

  router.get('/reports/:rid/download', requireLogin, (req, res) => {
    const report = getReport(req.params.rid, req.user?.id ?? null);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const format = ['md', 'csv', 'json'].includes(req.query.format) ? req.query.format : 'md';
    const base = `report-${report.id}`;
    const body =
      format === 'csv' ? reportCsv(report) : format === 'json' ? JSON.stringify(report, null, 2) : reportMarkdown(report);
    const type = { md: 'text/markdown', csv: 'text/csv', json: 'application/json' }[format];
    res.setHeader('Content-Type', `${type}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="${base}.${format}"`);
    res.send(body);
  });

  router.delete('/reports/:rid', requireLogin, (req, res) => {
    if (!deleteReport(req.params.rid, req.user?.id ?? null)) return res.status(404).json({ error: 'Report not found' });
    res.json({ ok: true });
  });

  // 首页那个「我创建的房间」列表用的。房间号本身就是凭证，所以不另做鉴权 ——
  // 调用方得先知道 ID 才问得出来。
  router.post('/rooms/summaries', (req, res) => {
    // 批量导入一次就是 100 个房间，Your rooms 可能有上千个
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 5000) : [];
    res.json({ rooms: roomSummaries(ids) });
  });

  router.patch('/rooms/:id', requireRoom, requireHost, (req, res) => {
    const title = renameRoom(req.room.id, req.body?.title);
    broadcast(req.room.id);
    res.json({ ok: true, title });
  });

  router.delete('/rooms/:id', requireRoom, requireHost, (req, res) => {
    deleteRoom(req.room.id);
    res.json({ ok: true });
  });

  router.get('/rooms/:id', requireRoom, (req, res) => {
    res.json({ state: roomState(req.room.id), progress: jobStatus(req.room.id) });
  });

  router.get('/rooms/:id/lines', requireRoom, (req, res) => {
    res.json({ lines: getLines(req.room.id) });
  });

  // 先看解析结果再决定要不要提交 —— 上传是不可逆的，值得多这一步
  router.post('/transcript/preview', (req, res) => {
    const text = typeof req.body === 'string' ? req.body : req.body?.text;
    const mergeConsecutive = req.body?.mergeConsecutive !== false;
    const excludeSpeakers = Array.isArray(req.body?.excludeSpeakers) ? req.body.excludeSpeakers : [];
    const parsed = parseTranscript(text, { mergeConsecutive, excludeSpeakers });
    res.json({
      speakers: parsed.speakers,
      candidates: parsed.candidates,
      warnings: parsed.warnings,
      format: parsed.format,
      lineCount: parsed.lines.length,
      preview: parsed.lines.slice(0, 12),
      charCount: parsed.lines.reduce((n, l) => n + l.content.length, 0),
    });
  });

  router.post('/rooms/:id/transcript', requireRoom, requireHost, (req, res) => {
    const text = req.body?.text;
    const mergeConsecutive = req.body?.mergeConsecutive !== false;
    const excludeSpeakers = Array.isArray(req.body?.excludeSpeakers) ? req.body.excludeSpeakers : [];
    const parsed = parseTranscript(text, { mergeConsecutive, excludeSpeakers });

    if (!parsed.lines.length) {
      return res.status(400).json({ error: parsed.warnings[0] || 'No lines were parsed' });
    }

    try {
      setTranscript(req.room.id, parsed);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // 这里不启动合成 —— 等房主把各角色的音色语气确认好，再手动点「合成音频」。
    // 否则刚传完就按随机出来的设定烧一整轮 TTS，改一次白花一次。
    broadcast(req.room.id, { withLines: true });

    res.json({
      ok: true,
      lineCount: parsed.lines.length,
      speakers: parsed.speakers,
      warnings: parsed.warnings,
    });
  });

  // 内容寻址，永不失效
  router.get('/audio/:hash.mp3', (req, res) => {
    const hash = req.params.hash;
    if (!HASH_RE.test(hash)) return res.status(400).end();
    const file = audioPath(hash);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.sendFile(file);
  });

  return router;
}
