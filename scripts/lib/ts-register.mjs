// 用 node --import ./scripts/lib/ts-register.mjs 挂上解析钩子
import { register } from 'node:module';
register(new URL('./ts-hooks.mjs', import.meta.url));
