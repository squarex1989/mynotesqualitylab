// 评估用的 LLM 调用：OpenRouter 的 chat/completions + structured outputs（JSON Schema strict）。
//
// 只有一个判定模型（EVAL_MODEL，默认 Claude）。模型只回答语义问题 —— 这条陈述有没有
// 原文支撑、这个信息点有没有被覆盖、这个错误改没改变意思 —— 并给出可核对的证据；
// 所有分数都由代码根据这些结论算出来，模型不直接打分。

const BASE_URL = () =>
  (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');

export const EVAL_MODEL = () => process.env.EVAL_MODEL || 'anthropic/claude-opus-5';

export function apiKeyProblem(key = process.env.OPENROUTER_API_KEY) {
  if (!key) return 'OPENROUTER_API_KEY is not set';
  if (/[^\x20-\x7e]/.test(key))
    return 'OPENROUTER_API_KEY contains non-ASCII characters — looks like a placeholder';
  if (key.length < 20) return `OPENROUTER_API_KEY is only ${key.length} characters`;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调一次模型，要求按 schema 返回 JSON。失败按状态码决定要不要重试。
 *
 * @returns {{data: any, usage: number, model: string}}
 */
export async function callJson({
  system,
  user,
  schema,
  name,
  model = EVAL_MODEL(),
  temperature = 0,
  timeoutMs = 300000,
  reasoning,
}) {
  const problem = apiKeyProblem();
  if (problem) throw new Error(problem);

  const body = {
    model,
    temperature,
    ...(reasoning ? { reasoning: { effort: reasoning } } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE_URL()}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const raw = (await res.text().catch(() => '')) || '';
        let message = raw.slice(0, 300);
        try {
          message = JSON.parse(raw)?.error?.message || message;
        } catch {
          /* 不是 JSON 就用原文 */
        }
        const err = new Error(message || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content;
      if (!text) throw new Error(`${name}: the model returned an empty response`);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`${name}: the model returned non-JSON: ${String(text).slice(0, 200)}`);
      }
      return { data, usage: Number(json?.usage?.total_tokens || 0), model };
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const hopeless = status === 400 || status === 401 || status === 402 || status === 403;
      if (hopeless || attempt === 2) break;
      await sleep(1500 * 2 ** attempt);
    }
  }
  throw lastErr;
}
