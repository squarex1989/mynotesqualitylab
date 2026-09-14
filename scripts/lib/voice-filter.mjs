// 从 Fish 公开音色库里挑「像在开会说话」的声音。
//
// 为什么要打分而不是直接用标签筛：Fish 的标签体系里没有「会议」或「对话」这一类，
// Discovery 页面那排 chip 是 Professional / Narration / Anime / Dramatic / Mysterious
// 这种，恰好都是我们不想要的方向。每个音色自带的 tags 是自由文本，描述里信息更多，
// 所以对「tags + 标题 + 描述」整体做关键词正负打分，再按语种 × 性别配额挑。

/** 命中就直接排除 —— 这些声音放进会议里会很突兀 */
const BLOCK = [
  'anime', 'character-voice', 'character voice', 'vtuber', 'cartoon', 'game',
  'singing', 'singer', 'sing', 'rap', 'asmr', 'whisper-only',
  'celebrity', 'impression', 'robot', 'monster', 'creature', 'demon',
  'child', 'kid', 'baby', 'loli', 'shota',
  '动漫', '二次元', '角色', '游戏', '唱', '鬼畜', '萝莉', '童声', '机器人',
];

/** 扣分 —— 不是不能用，但明显是表演/播音路线，不像同事在说话 */
const PENALTY = [
  ['narration', 3], ['narrator', 3], ['announcer', 4], ['broadcast', 3],
  ['audiobook', 2], ['storytelling', 2], ['documentary', 2],
  ['advertisement', 3], ['commercial', 3], ['promo', 3], ['trailer', 4],
  ['dramatic', 3], ['theatrical', 3], ['epic', 3], ['cinematic', 3],
  ['mysterious', 2], ['sexy', 3], ['seductive', 3], ['breathy', 2],
  ['entertainment', 2], ['exaggerated', 3], ['energetic', 1], ['shouting', 3],
  ['播音', 4], ['旁白', 3], ['解说', 3], ['配音', 3], ['主播', 2],
  ['播报', 4], ['广告', 3], ['宣传', 3], ['朗诵', 3], ['磁性', 2], ['撒娇', 4],
];

/** 加分 —— 越像日常对话越好 */
const BONUS = [
  ['conversational', 5], ['conversation', 4], ['natural', 4], ['casual', 4],
  ['everyday', 4], ['relaxed', 3], ['friendly', 3], ['warm', 2],
  ['calm', 3], ['clear', 3], ['neutral', 3], ['steady', 2],
  ['podcast', 3], ['interview', 4], ['meeting', 6], ['business', 3],
  ['professional', 2], ['colleague', 5], ['explaining', 2],
  ['自然', 4], ['口语', 5], ['对话', 4], ['日常', 4], ['亲切', 3],
  ['沉稳', 3], ['平和', 3], ['聊天', 4], ['交流', 3], ['会议', 6],
];

const GENDER_WORDS = {
  female: ['female', 'woman', 'girl', '女', '少女', '妈妈', '姐'],
  male: ['male', 'man', 'boy', '男', '少年', '爸爸', '哥'],
};

function haystack(voice) {
  return [voice.title, voice.description, ...(voice.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function guessGender(voice) {
  const hay = haystack(voice);
  // 先看 tags —— 那是结构化的，比从描述里猜可靠
  const tags = (voice.tags || []).map((t) => String(t).toLowerCase());
  if (tags.includes('female')) return 'female';
  if (tags.includes('male')) return 'male';
  if (tags.includes('neutral')) return 'neutral';
  // female 要先判：'female' 里含 'male'，顺序反了会全判成男声
  if (GENDER_WORDS.female.some((w) => hay.includes(w))) return 'female';
  if (GENDER_WORDS.male.some((w) => hay.includes(w))) return 'male';
  return 'neutral';
}

/**
 * @returns {{ score: number, blocked: string|null, hits: string[] }}
 *   score 越高越像会议里的声音；blocked 非空表示直接排除
 */
export function scoreVoice(voice) {
  const hay = haystack(voice);

  const blocked = BLOCK.find((w) => hay.includes(w)) || null;
  if (blocked) return { score: -Infinity, blocked, hits: [] };

  let score = 0;
  const hits = [];
  for (const [word, weight] of BONUS) {
    if (hay.includes(word)) {
      score += weight;
      hits.push(`+${word}`);
    }
  }
  for (const [word, weight] of PENALTY) {
    if (hay.includes(word)) {
      score -= weight;
      hits.push(`-${word}`);
    }
  }
  // 有描述说明作者花了心思，也让打分更有依据
  if (voice.description && String(voice.description).length > 30) score += 1;
  return { score, blocked: null, hits };
}

/**
 * 按「语种 × 性别」配额挑，保证各语种各性别都有覆盖，
 * 而不是让某个语种的高分音色把名额占满。
 * @param {Array} scored  [{ voice, lang, gender, score, hits }]
 * @param {number} perBucket 每个桶取几个
 */
export function pickBalanced(scored, perBucket) {
  const buckets = new Map();
  for (const item of scored) {
    if (item.score === -Infinity) continue;
    const key = `${item.lang}:${item.gender}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const out = [];
  for (const [key, list] of [...buckets.entries()].sort()) {
    list.sort((a, b) => b.score - a.score || (b.voice.task_count ?? 0) - (a.voice.task_count ?? 0));
    out.push(...list.slice(0, perBucket).map((x) => ({ ...x, bucket: key })));
  }
  return out;
}
