// 由 scripts/fetch-voice-tags.mjs 生成的 voice-tags.json 的读取封装
import fs from 'node:fs';

export const VOICE_TAGS = JSON.parse(
  fs.readFileSync(new URL('./voice-tags.json', import.meta.url), 'utf8')
);
