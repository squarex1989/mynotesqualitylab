import express from 'express';
import fs from 'node:fs';
import { audioPath } from './db.js';
import { parseTranscript } from './parse.js';
import { voices, usingFallbackVoices, DIMENSIONS } from './voices.js';
import {
  createRoom,
  getRoom,
  isHostToken,
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
import {
  PRODUCTS,
  QUESTIONS as JUDGE_QUESTIONS,
  JUDGES,
  apiKeyProblem as judgeKeyProblem,
} from './judge.js';

const HASH_RE = /^[a-f0-9]{32}$/;

export function createApiRouter({ broadcast }) {
  const router = express.Router();

  router.use(express.json({ limit: '12mb' }));
  router.use(express.text({ limit: '12mb', type: 'text/plain' }));

  const requireRoom = (req, res, next) => {
    const room = getRoom(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    req.room = room;
    next();
  };

  const requireHost = (req, res, next) => {
    const token = req.get('x-host-token');
    if (!isHostToken(req.room, token)) {
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
      fallbackVoices: usingFallbackVoices(),
      titleMaxWeight: TITLE_MAX_WEIGHT,
      ttsConfigured: !problem,
      ttsProblem: problem,
      compare: {
        products: PRODUCTS,
        questions: JUDGE_QUESTIONS.map((q) => ({ key: q.key, label: q.label, ask: q.ask })),
        judges: JUDGES.map((j) => ({ id: j.id, label: j.label, model: j.model })),
        problem: judgeKeyProblem(),
      },
    });
  });

  router.post('/rooms', (req, res) => {
    const { id, hostToken } = createRoom({ title: req.body?.title });
    res.json({ id, hostToken });
  });

  // 首页那个「我创建的房间」列表用的。房间号本身就是凭证，所以不另做鉴权 ——
  // 调用方得先知道 ID 才问得出来。
  router.post('/rooms/summaries', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 200) : [];
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
