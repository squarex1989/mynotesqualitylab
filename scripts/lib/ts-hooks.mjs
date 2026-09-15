// Node 的 ESM 解析器要求写全扩展名，而项目里的 import 是打包器风格的省略写法
//（'./api' 而不是 './api.ts'）。这个钩子把省略的那部分补上，让测试脚本能直接
// 导入 lib/ 下的 TypeScript 源码 —— 测真实代码，不测副本。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXTS = ['.ts', '.tsx', '.mts', '.js'];

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[mc]?[jt]sx?$/.test(specifier)) {
    const base = new URL(specifier, context.parentURL);
    for (const ext of EXTS) {
      const candidate = new URL(base.href + ext);
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
    }
  }
  return next(specifier, context);
}
