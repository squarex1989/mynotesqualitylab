// Gemini 3.1 Flash TTS（经 OpenRouter）的 30 个预置音色，以及
// 「年龄感 / 语气 / 口音 / 语速 / 情绪 / 说话习惯」怎么被拼成风格标签。
//
// 和 OpenAI 不同，这个接口没有独立的 instructions 参数 —— 风格靠一段
// [方括号标签] 拼在台词前面，方括号里可以写任意自然语言，标签本身不会被读出来。
// 所以这里每个选项给的是一个短语，最后用逗号连成一行。
//
// 这里没有「性别」：性别由 voice 本身决定（下面每个音色都标着男声/女声），
// 再在标签里写一句 "a male speaker" 只会和音色打架。

export const VOICES = [
  { id: 'Zephyr', label: 'Zephyr', gender: 'female', note: '明亮' },
  { id: 'Puck', label: 'Puck', gender: 'male', note: '轻快上扬' },
  { id: 'Charon', label: 'Charon', gender: 'male', note: '沉稳、讲解感' },
  { id: 'Kore', label: 'Kore', gender: 'female', note: '坚定' },
  { id: 'Fenrir', label: 'Fenrir', gender: 'male', note: '易激动' },
  { id: 'Leda', label: 'Leda', gender: 'female', note: '年轻' },
  { id: 'Orus', label: 'Orus', gender: 'male', note: '坚定' },
  { id: 'Aoede', label: 'Aoede', gender: 'female', note: '轻盈' },
  { id: 'Callirrhoe', label: 'Callirrhoe', gender: 'female', note: '随和' },
  { id: 'Autonoe', label: 'Autonoe', gender: 'female', note: '明亮' },
  { id: 'Enceladus', label: 'Enceladus', gender: 'male', note: '气声' },
  { id: 'Iapetus', label: 'Iapetus', gender: 'male', note: '清晰' },
  { id: 'Umbriel', label: 'Umbriel', gender: 'male', note: '随和' },
  { id: 'Algieba', label: 'Algieba', gender: 'male', note: '顺滑' },
  { id: 'Despina', label: 'Despina', gender: 'female', note: '顺滑' },
  { id: 'Erinome', label: 'Erinome', gender: 'female', note: '清晰' },
  { id: 'Algenib', label: 'Algenib', gender: 'male', note: '沙哑' },
  { id: 'Rasalgethi', label: 'Rasalgethi', gender: 'male', note: '讲解感' },
  { id: 'Laomedeia', label: 'Laomedeia', gender: 'female', note: '轻快上扬' },
  { id: 'Achernar', label: 'Achernar', gender: 'female', note: '柔软' },
  { id: 'Alnilam', label: 'Alnilam', gender: 'male', note: '坚定' },
  { id: 'Schedar', label: 'Schedar', gender: 'male', note: '平稳' },
  { id: 'Gacrux', label: 'Gacrux', gender: 'female', note: '成熟' },
  { id: 'Pulcherrima', label: 'Pulcherrima', gender: 'female', note: '有推进感' },
  { id: 'Achird', label: 'Achird', gender: 'male', note: '友好' },
  { id: 'Zubenelgenubi', label: 'Zubenelgenubi', gender: 'male', note: '随意' },
  { id: 'Vindemiatrix', label: 'Vindemiatrix', gender: 'female', note: '温和' },
  { id: 'Sadachbia', label: 'Sadachbia', gender: 'male', note: '活泼' },
  { id: 'Sadaltager', label: 'Sadaltager', gender: 'male', note: '博学感' },
  { id: 'Sulafat', label: 'Sulafat', gender: 'female', note: '温暖' },
];

export const VOICE_IDS = VOICES.map((v) => v.id);

// 每个维度：value 给机器，label 给 UI，tag 拼进方括号（空字符串 = 这一项不进标签）
export const DIMENSIONS = {
  age: {
    label: '年龄感',
    options: [
      { value: 'young', label: '年轻', tag: 'youthful voice' },
      { value: 'middle', label: '中年', tag: 'middle-aged voice' },
      { value: 'senior', label: '年长', tag: 'elderly voice' },
    ],
  },
  tone: {
    label: '语气',
    options: [
      { value: 'professional', label: '专业冷静', tag: 'composed and professional' },
      { value: 'warm', label: '热情友好', tag: 'warm and friendly' },
      { value: 'tired', label: '疲惫低落', tag: 'tired, low energy, almost sighing' },
      { value: 'excited', label: '兴奋急促', tag: 'excited, slightly breathless' },
      { value: 'authoritative', label: '严肃权威', tag: 'serious and authoritative' },
      { value: 'gentle', label: '温柔耐心', tag: 'gentle and patient' },
      { value: 'sarcastic', label: '讽刺挖苦', tag: 'dry and sarcastic' },
      { value: 'anxious', label: '紧张焦虑', tag: 'anxious and tense' },
      { value: 'casual', label: '随意轻松', tag: 'casual and relaxed' },
      { value: 'deadpan', label: '一本正经', tag: 'deadpan, matter-of-fact' },
    ],
  },
  accent: {
    label: '口音',
    options: [
      // 标准口音不进标签 —— 少说一句总比和音色本身打架好
      { value: 'us', label: '标准美音', tag: '' },
      { value: 'uk', label: '英式口音', tag: 'British accent' },
      { value: 'au', label: '澳洲口音', tag: 'Australian accent' },
      { value: 'in', label: '印度口音', tag: 'Indian English accent' },
      { value: 'scot', label: '苏格兰口音', tag: 'Scottish accent' },
      { value: 'southern', label: '美国南方口音', tag: 'Southern American drawl' },
      { value: 'nyc', label: '纽约口音', tag: 'New York accent' },
      { value: 'mandarin', label: '标准普通话', tag: '标准普通话，播音腔' },
      { value: 'taiwan', label: '台湾腔', tag: '台湾腔，语尾上扬' },
      { value: 'cantonese-mandarin', label: '粤语腔普通话', tag: '带粤语口音的普通话' },
      { value: 'northeast', label: '东北口音', tag: '东北口音' },
      { value: 'sichuan', label: '四川口音', tag: '四川口音' },
    ],
  },
  pace: {
    label: '语速',
    // 这个接口没有 speed 参数，语速只能写进标签
    options: [
      { value: 'very-slow', label: '很慢', tag: 'speaking very slowly, with long pauses' },
      { value: 'slow', label: '偏慢', tag: 'unhurried' },
      { value: 'normal', label: '正常', tag: '' },
      { value: 'fast', label: '偏快', tag: 'brisk' },
      { value: 'very-fast', label: '很快', tag: 'rapid-fire' },
    ],
  },
  emotion: {
    label: '情绪强度',
    options: [
      { value: 'flat', label: '平淡', tag: 'flat, minimal emotion' },
      { value: 'moderate', label: '适中', tag: '' },
      { value: 'strong', label: '强烈', tag: 'highly expressive' },
    ],
  },
  quirk: {
    label: '说话习惯',
    options: [
      { value: 'none', label: '无', tag: '' },
      { value: 'filler', label: '有口头停顿', tag: 'hesitant, with natural pauses' },
      { value: 'clipped', label: '短促干脆', tag: 'clipped and terse' },
      { value: 'trailing', label: '句尾拖长', tag: 'trailing off at sentence ends' },
      { value: 'emphatic', label: '爱强调重点', tag: 'emphasizing the key word' },
      { value: 'smiling', label: '带着笑意', tag: 'smiling' },
      { value: 'whisper', label: '压低声音', tag: 'half-whispering' },
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

/**
 * 把下拉配置拼成方括号里的那段文字。几个短语用逗号连成一行 ——
 * 调用时会变成 `[youthful voice, dry and sarcastic, brisk] 台词内容`。
 */
export function buildInstructions(config) {
  return DIMENSION_KEYS.map((key) => optionFor(key, config[key])?.tag)
    .filter(Boolean)
    .join(', ');
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
  return VOICE_IDS.includes(voice) ? voice : VOICES[0].id;
}
