// gpt-4o-mini-tts 支持的音色，以及「年龄感 / 语气 / 口音 / 语速 / 情绪 / 说话习惯」
// 这些维度怎么被拼成 instructions。
//
// instructions 用英文写 —— 这是模型的指令通道，英文指令对 accent / delivery 的服从度
// 明显更好；被朗读的正文是什么语言都不影响。
//
// 这里没有「性别」：性别由 voice 本身决定（下面每个音色都标着男声/女声），
// 再在 instructions 里写一句 "a male speaker" 只会和音色打架。

export const VOICES = [
  { id: 'alloy', label: 'Alloy', gender: 'neutral', note: '中性、平稳，偏播音' },
  { id: 'ash', label: 'Ash', gender: 'male', note: '男声，沉稳干燥' },
  { id: 'ballad', label: 'Ballad', gender: 'male', note: '男声，抒情、有起伏' },
  { id: 'coral', label: 'Coral', gender: 'female', note: '女声，明亮热情' },
  { id: 'echo', label: 'Echo', gender: 'male', note: '男声，克制冷静' },
  { id: 'fable', label: 'Fable', gender: 'male', note: '男声，讲故事感，略英伦' },
  { id: 'nova', label: 'Nova', gender: 'female', note: '女声，年轻利落' },
  { id: 'onyx', label: 'Onyx', gender: 'male', note: '男声，低沉厚重' },
  { id: 'sage', label: 'Sage', gender: 'female', note: '女声，柔和沉着' },
  { id: 'shimmer', label: 'Shimmer', gender: 'female', note: '女声，轻快明快' },
  { id: 'verse', label: 'Verse', gender: 'male', note: '男声，随和口语化' },
];

export const VOICE_IDS = VOICES.map((v) => v.id);

// 每个维度：value 给机器，label 给 UI，prompt 拼进 instructions。
export const DIMENSIONS = {
  age: {
    label: '年龄感',
    options: [
      { value: 'young', label: '年轻', prompt: 'in their twenties' },
      { value: 'middle', label: '中年', prompt: 'in their forties' },
      { value: 'senior', label: '年长', prompt: 'in their sixties' },
    ],
  },
  tone: {
    label: '语气',
    options: [
      {
        value: 'professional',
        label: '专业冷静',
        prompt: 'Composed and professional, like a senior colleague presenting findings.',
      },
      {
        value: 'warm',
        label: '热情友好',
        prompt: 'Warm, friendly and encouraging, smiling while speaking.',
      },
      {
        value: 'tired',
        label: '疲惫低落',
        prompt: 'Tired and flat, low energy, as if at the end of a very long day.',
      },
      {
        value: 'excited',
        label: '兴奋急促',
        prompt: 'Excited and slightly breathless, eager to get the words out.',
      },
      {
        value: 'authoritative',
        label: '严肃权威',
        prompt: 'Serious and authoritative, used to being listened to without interruption.',
      },
      {
        value: 'gentle',
        label: '温柔耐心',
        prompt: 'Gentle and patient, soft-edged, never rushing the listener.',
      },
      {
        value: 'sarcastic',
        label: '讽刺挖苦',
        prompt: 'Dry and sarcastic, with a faint smirk behind every sentence.',
      },
      {
        value: 'anxious',
        label: '紧张焦虑',
        prompt: 'Anxious and slightly tense, as if worried about being wrong.',
      },
      {
        value: 'casual',
        label: '随意轻松',
        prompt: 'Casual and relaxed, conversational, like chatting with a friend.',
      },
      {
        value: 'deadpan',
        label: '一本正经',
        prompt: 'Deadpan and matter-of-fact, with almost no emotional coloring.',
      },
    ],
  },
  accent: {
    label: '口音',
    options: [
      { value: 'us', label: '标准美音', prompt: 'Neutral General American English accent.' },
      { value: 'uk', label: '英式口音', prompt: 'British RP accent.' },
      { value: 'au', label: '澳洲口音', prompt: 'Australian accent.' },
      { value: 'in', label: '印度口音', prompt: 'Indian English accent.' },
      { value: 'scot', label: '苏格兰口音', prompt: 'Scottish accent.' },
      { value: 'southern', label: '美国南方口音', prompt: 'American Southern drawl.' },
      { value: 'nyc', label: '纽约口音', prompt: 'New York City accent.' },
      {
        value: 'mandarin',
        label: '标准普通话',
        prompt: 'Standard Mandarin Chinese, clean broadcast pronunciation.',
      },
      {
        value: 'taiwan',
        label: '台湾腔',
        prompt: 'Taiwanese Mandarin accent, softer tones and rising sentence endings.',
      },
      {
        value: 'cantonese-mandarin',
        label: '粤语腔普通话',
        prompt: 'Mandarin spoken with a Cantonese accent.',
      },
      {
        value: 'northeast',
        label: '东北口音',
        prompt: 'Northeastern Chinese (Dongbei) accent, blunt and lively.',
      },
      { value: 'sichuan', label: '四川口音', prompt: 'Sichuanese-accented Mandarin.' },
    ],
  },
  pace: {
    label: '语速',
    options: [
      {
        value: 'very-slow',
        label: '很慢',
        prompt: 'Very slow, with long deliberate pauses between clauses.',
      },
      { value: 'slow', label: '偏慢', prompt: 'Slower than average, unhurried.' },
      { value: 'normal', label: '正常', prompt: 'Natural conversational pace.' },
      { value: 'fast', label: '偏快', prompt: 'Brisk, faster than average.' },
      {
        value: 'very-fast',
        label: '很快',
        prompt: 'Rapid-fire, words running into each other.',
      },
    ],
  },
  emotion: {
    label: '情绪强度',
    options: [
      { value: 'flat', label: '平淡', prompt: 'Minimal emotional range; keep it level.' },
      { value: 'moderate', label: '适中', prompt: 'Moderate emotional range; natural rise and fall.' },
      { value: 'strong', label: '强烈', prompt: 'Wide emotional range; lean into the peaks.' },
    ],
  },
  quirk: {
    label: '说话习惯',
    options: [
      { value: 'none', label: '无', prompt: '' },
      {
        value: 'filler',
        label: '有口头停顿',
        prompt: 'Occasionally hesitate with natural filler pauses before a thought.',
      },
      {
        value: 'clipped',
        label: '短促干脆',
        prompt: 'Clip sentences short; do not let them trail off.',
      },
      { value: 'trailing', label: '句尾拖长', prompt: 'Let sentence endings trail off slightly.' },
      { value: 'emphatic', label: '爱强调重点', prompt: 'Land hard on the key word of each sentence.' },
      { value: 'smiling', label: '带着笑意', prompt: 'Audible smile throughout.' },
      {
        value: 'whisper',
        label: '压低声音',
        prompt: 'Keep the volume down, close to a confidential half-whisper.',
      },
    ],
  },
};

export const DIMENSION_KEYS = Object.keys(DIMENSIONS);

function optionFor(key, value) {
  return DIMENSIONS[key]?.options.find((o) => o.value === value) || null;
}

export function labelFor(key, value) {
  return optionFor(key, value)?.label ?? value;
}

/** 把下拉配置拼成 gpt-4o-mini-tts 的 instructions。 */
export function buildInstructions(config) {
  const lines = [
    `Voice: a speaker ${optionFor('age', config.age)?.prompt || ''}`.trimEnd() + '.',
    `Tone: ${optionFor('tone', config.tone)?.prompt || ''}`,
    `Accent/Pronunciation: ${optionFor('accent', config.accent)?.prompt || ''}`,
    `Pacing: ${optionFor('pace', config.pace)?.prompt || ''}`,
    `Emotion: ${optionFor('emotion', config.emotion)?.prompt || ''}`,
  ];

  const quirk = optionFor('quirk', config.quirk)?.prompt;
  if (quirk) lines.push(`Delivery quirk: ${quirk}`);

  lines.push(
    'Read the line as a single turn of natural dialogue in a live conversation. ' +
      'Do not announce the speaker name, do not add commentary, do not read stage directions aloud.'
  );

  return lines.join('\n');
}

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

/** 随机生成一个角色配置。优先挑还没被占用的音色，免得一屋子人是同一个声音。 */
export function randomSpeakerConfig({ avoidVoices = [], rng = Math.random } = {}) {
  const fresh = VOICES.filter((v) => !avoidVoices.includes(v.id));
  const voice = pick(fresh.length ? fresh : VOICES, rng).id;

  const config = {
    age: pick(DIMENSIONS.age.options, rng).value,
    tone: pick(DIMENSIONS.tone.options, rng).value,
    // 口音随机时偏向“无口音”，否则整屋子人都在飙口音，听起来像杂技
    accent: rng() < 0.55 ? 'us' : pick(DIMENSIONS.accent.options, rng).value,
    pace: pick(
      DIMENSIONS.pace.options.filter((o) => o.value !== 'very-fast' && o.value !== 'very-slow'),
      rng
    ).value,
    emotion: pick(DIMENSIONS.emotion.options, rng).value,
    quirk: rng() < 0.6 ? 'none' : pick(DIMENSIONS.quirk.options, rng).value,
  };

  return { voice, config, instructions: buildInstructions(config) };
}

/** 把任意输入规整成合法配置，非法值回落到第一个选项。 */
export function normalizeConfig(input = {}) {
  const out = {};
  for (const key of DIMENSION_KEYS) {
    const dim = DIMENSIONS[key];
    const hit = dim.options.find((o) => o.value === input[key]);
    out[key] = hit ? hit.value : dim.options[0].value;
  }
  return out;
}

export function normalizeVoice(voice) {
  return VOICE_IDS.includes(voice) ? voice : 'alloy';
}
