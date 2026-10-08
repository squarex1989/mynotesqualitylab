// 语种识别：只看字符和常用词，不调模型。
//
//   detectLanguage(text)   整段文本的主语种（房间脚本、整份摘要）
//   lineLanguage(text)     一小段话的语种 —— 转录的逐行语言检查用。太短判断不了时返回 null；
//                          拉丁字母的短句分不清是英语还是西语，返回 'latin'（只说明是拉丁字母）

export const LATIN_LANGS = ['en', 'fr', 'de', 'es', 'pt', 'it', 'nl'];

const STOPWORDS = {
  en: ['the', 'and', 'is', 'you', 'that', 'to', 'of', 'we', 'it', 'this', 'what', 'i'],
  fr: ['le', 'la', 'les', 'et', 'est', 'vous', 'nous', 'que', 'pas', 'une', 'je', 'des'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'wir', 'ich', 'sie', 'ein', 'zu', 'es'],
  es: ['el', 'los', 'que', 'y', 'es', 'no', 'una', 'por', 'para', 'está', 'las', 'pero'],
  pt: ['o', 'os', 'que', 'não', 'é', 'uma', 'para', 'você', 'está', 'com', 'mas', 'isso'],
  it: ['il', 'che', 'non', 'è', 'per', 'una', 'sono', 'gli', 'della', 'ma', 'questo', 'io'],
  nl: ['de', 'het', 'een', 'en', 'niet', 'dat', 'ik', 'je', 'wij', 'van', 'is', 'we'],
};

const count = (s, re) => (s.match(re) || []).length;

function scripts(text) {
  const s = String(text || '');
  return {
    kana: count(s, /[぀-ヿ]/g),
    han: count(s, /[一-鿿]/g),
    hangul: count(s, /[가-힯]/g),
    latin: count(s, /[a-zA-ZÀ-ɏ]/g),
  };
}

function latinByStopwords(text, minHits = 1) {
  const words = String(text).toLowerCase().match(/[\p{L}]+/gu) || [];
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  let best = null;
  let bestScore = 0;
  let second = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const score = list.reduce((n, w) => n + (freq.get(w) || 0), 0);
    if (score > bestScore) {
      second = bestScore;
      best = lang;
      bestScore = score;
    } else if (score > second) second = score;
  }
  return bestScore >= minHits && bestScore > second ? best : null;
}

/** 整段文本的主语种。拉丁字母文本按常用词打分，默认 en */
export function detectLanguage(text) {
  const sample = String(text || '').slice(0, 20000);
  const { kana, han, hangul, latin } = scripts(sample);
  if (kana > 10 && kana * 10 > han) return 'ja';
  if (hangul > 10 && hangul > latin / 3) return 'ko';
  if (han > latin / 3 && han > 10) return kana > 10 ? 'ja' : 'zh';
  return latinByStopwords(sample) || 'en';
}

/**
 * 一小段话的语种。
 * @returns {'zh'|'ja'|'ko'|'en'|...|'latin'|null}
 */
export function lineLanguage(text) {
  const { kana, han, hangul, latin } = scripts(text);
  const cjk = kana + han + hangul;
  if (cjk + latin < 4) return null; // 「OK」「嗯」这种太短，判断不了
  if (cjk * 2 >= latin) {
    // 以 CJK 字符为主（拉丁字母按字母数算，一个词好几个字母，所以 CJK 乘 2 比）
    if (kana > 0) return 'ja';
    if (hangul > han) return 'ko';
    return han ? 'zh' : null;
  }
  const words = (String(text).match(/[\p{L}]+/gu) || []).length;
  if (words < 6) return 'latin';
  return latinByStopwords(text, 2) || 'latin';
}

/** 实际语种和期望是否一致。'latin' 只说明是拉丁字母，期望是任何拉丁语种都算一致 */
export function languageMatches(expected, got) {
  if (!got || !expected) return true;
  if (got === 'latin') return LATIN_LANGS.includes(expected);
  return got === expected;
}
