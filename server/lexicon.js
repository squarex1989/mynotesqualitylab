// 词表：语气词（权重低）和否定词（权重高、且是「意思被弄反」的线索）。
//
// 覆盖英/中/西/日 —— 就是房间里那些音色的语种。
//
// 收词的原则是「宁少勿多」：一个词只有在几乎不可能承载实质内容时才收进
// FILLERS。像中文的「这个 / 那个 / 就是 / 然后」口语里确实常当语气词用，但
// 「这个方案」里的「这个」是内容，收进来会把真实的漏词按 0.1 算掉，所以不收。
// 英文的 like / so / right / well 同理，只在明显是话头的位置才算 —— 做不到
// 判断位置，就不收。宁可让权重偏保守，也不要让它偷偷抹平真实错误。

/**
 * 语气词 / 填充词。中日文按字切，所以这里写的是**短语**，
 * 匹配时在整行文本上找，再把覆盖到的 token 标记出来（见 metrics.js）。
 */
export const FILLERS = [
  // 英文
  'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'oh', 'ooh', 'eh',
  'hmm', 'hm', 'mm', 'mmm', 'mhm', 'uh-huh', 'huh', 'yeah', 'yea', 'yep', 'yup',
  'nah', 'okay', 'ok', 'alright', 'i mean', 'you know', "y'know", 'sort of', 'kind of',

  // 中文：只收感叹词和句末语气助词
  '嗯', '呃', '唉', '诶', '欸', '哦', '噢', '喔', '啊', '呀', '哇', '哎', '唔',
  '吧', '呢', '吗', '嘛', '呗', '咯', '啦', '嘞', '哈',

  // 西班牙语
  'eh', 'em', 'ehm', 'este', 'esto', 'pues', 'bueno', 'vale', 'o sea', 'osea',
  'ajá', 'aja', 'digamos', 'mmm',

  // 日语
  'えー', 'えーと', 'えっと', 'ええと', 'あのー', 'あの', 'そのー', 'その',
  'まあ', 'まぁ', 'なんか', 'うーん', 'ううん', 'ええ', 'あー', 'おー', 'ねえ',
];

/**
 * 否定词。漏掉或多出一个否定词，句子意思直接反过来 —— 所以：
 *   1. 权重按关键词算（最高档）
 *   2. 出现增删时作为线索交给 LLM 去判断意思是否真的被弄反了
 */
export const NEGATIONS = [
  // 英文
  'not', 'no', 'never', 'none', 'nobody', 'nothing', 'neither', 'nor', 'without',
  'cannot', "can't", 'cant', "don't", 'dont', "doesn't", "didn't", "won't", "wouldn't",
  "shouldn't", "couldn't", "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't",
  "hadn't", "ain't", 'unable', 'unless',

  // 中文
  '不是', '不会', '不能', '不要', '不用', '不行', '没有', '无法', '并非', '未必',
  '不', '没', '无', '非', '未', '别', '勿', '莫',

  // 西班牙语
  'no', 'nunca', 'jamás', 'nada', 'nadie', 'ningún', 'ninguna', 'ninguno', 'ni',
  'tampoco', 'sin',

  // 日语
  'ない', 'ません', 'ぬ', 'じゃない', 'ではない', 'しない', 'なし', '無い',
];

/** 三档权重。语气词几乎不算错，关键词算三倍。 */
export const WEIGHTS = { filler: 0.1, normal: 1, key: 3 };

/** 长短语要先匹配，否则「不是」会被「不」抢掉 */
const byLengthDesc = (a, b) => b.length - a.length;

export const FILLER_PHRASES = [...new Set(FILLERS)].sort(byLengthDesc);
export const NEGATION_PHRASES = [...new Set(NEGATIONS)].sort(byLengthDesc);

/**
 * 句中出现的大写词才算专有名词候选 —— 句首大写是语法要求，不是线索。
 * 这些词即使出现在句中也不算。
 */
export const CASE_NOISE = new Set(['i', "i'm", "i'll", "i've", "i'd", 'ok', 'okay']);
