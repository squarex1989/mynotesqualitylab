// 房间名长度规则：最多 20 个汉字 / 40 个字母，按「全角算 2、半角算 1」折算。
//
// server/rooms.js 里有一份一模一样的实现（服务端是 .js、前端是 .ts，没法直接
// 共用）。这边只负责给输入框做实时计数和截断，真正的规整以服务端为准。
export const TITLE_MAX_WEIGHT = 40;

const WIDE =
  /[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/;

export function titleWeight(s: string): number {
  let w = 0;
  for (const ch of s ?? '') w += WIDE.test(ch) ? 2 : 1;
  return w;
}

/** 按权重截断，供输入框 onChange 用 */
export function clampTitle(raw: string): string {
  let out = '';
  for (const ch of raw ?? '') {
    if (titleWeight(out + ch) > TITLE_MAX_WEIGHT) break;
    out += ch;
  }
  return out;
}
