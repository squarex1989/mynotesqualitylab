#!/usr/bin/env node
// 声音解锁状态机的断言。
//
// 跑法：node --import ./scripts/lib/ts-register.mjs scripts/check-audio-unlock.mjs
//
// 拿一个模拟手机行为的假 AudioContext 打真实的 AudioEngine：
//   - 没有用户手势时 resume() 抛错（手机上就是这样）
//   - 切后台 / 锁屏 / 来电会把 context 挂起，而且不由我们触发
//   - WebKit 上 resume() 可能先 resolve、state 稍后才翻成 running
//
// 钉住的回归：解锁成功后 context 被挂起，上报的状态不能卡在 blocked。
// 原来的实现在第一次解锁成功后就摘掉了手势监听，于是切后台回来之后
// visibilitychange 里那次无手势探测必然失败、上报 false，再也没救 ——
// 而声音其实出得来（播放路径用的是实时状态，用户一碰页面 context 就恢复了）。

let gestureAllowed = false;
let resumeLagMs = 0;

class FakeAudioContext extends EventTarget {
  constructor() {
    super();
    this.state = 'suspended';
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = {};
    FakeAudioContext.created++;
  }
  async resume() {
    if (!gestureAllowed) throw new Error('NotAllowedError');
    if (resumeLagMs > 0) {
      // WebKit：promise 先 resolve，状态稍后才翻过来
      setTimeout(() => this.#set('running'), resumeLagMs);
      return;
    }
    this.#set('running');
  }
  async suspend() {
    this.#set('suspended');
  }
  async close() {
    this.#set('closed');
  }
  /** 系统把它挂起了（切后台、锁屏、来电），不经过我们 */
  systemSuspend() {
    this.#set('suspended');
  }
  #set(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new Event('statechange'));
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() {}, stop() {} };
  }
  createBuffer() {
    return { duration: 0 };
  }
  createGain() {
    return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} };
  }
}
FakeAudioContext.created = 0;

globalThis.window = { AudioContext: FakeAudioContext };
// 诊断行要读 navigator，模拟成 iPhone 上的 Chrome —— 和实际出问题的那台一样。
// Node 自带一个只读的 navigator，得用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.98 Mobile/15E148 Safari/604.1',
    maxTouchPoints: 5,
  },
});
Object.defineProperty(globalThis, 'screen', {
  configurable: true,
  value: { width: 393, height: 852 },
});

const { AudioEngine, reportedAudioState, audioDiagnostics } = await import(
  '../lib/audioEngine.ts'
);

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

// ---------------------------------------------------------------- 1
console.log('\n1) 手机上进页面：没有手势，探测失败');
let e = new AudioEngine();
t('tryResume 返回 false', (await e.tryResume()) === false);
t('unlocked = false', e.unlocked === false);
t('everUnlocked = false', e.everUnlocked === false);
t('上报 blocked（该提示用户）', reportedAudioState(e) === 'blocked');

console.log('\n2) 失败的 context 丢掉，下次手势里重新建');
const before = FakeAudioContext.created;
e.discardIfLocked();
gestureAllowed = true;
t('tryResume 返回 true', (await e.tryResume()) === true);
t('确实新建了一个 context', FakeAudioContext.created === before + 1,
  `${FakeAudioContext.created} vs ${before}`);
t('unlocked = true', e.unlocked === true);
t('everUnlocked = true', e.everUnlocked === true);
t('上报 ready', reportedAudioState(e) === 'ready');

// ---------------------------------------------------------------- 3
console.log('\n3) 回归：切后台把 context 挂起后，状态不能卡在 blocked');
let notified = 0;
const off = e.onStateChange(() => notified++);
e.ctx.systemSuspend();
t('statechange 通知到了（不是我们触发的挂起也能感知）', notified === 1, `${notified}`);
t('unlocked = false（此刻确实播不出声）', e.unlocked === false);
t('everUnlocked 仍然 true', e.everUnlocked === true);
t('★ 上报仍是 ready，不是 blocked', reportedAudioState(e) === 'ready',
  reportedAudioState(e));

console.log('\n4) 回到前台时那次无手势探测失败，也不该翻成 blocked');
gestureAllowed = false;
t('无手势 tryResume 失败', (await e.tryResume()) === false);
t('★ 上报仍是 ready', reportedAudioState(e) === 'ready', reportedAudioState(e));
t('丢弃保护生效：解锁过的 context 不会被丢掉', e.ctx !== null);

console.log('\n5) 用户随手一碰就恢复');
gestureAllowed = true;
t('tryResume 成功', (await e.tryResume()) === true);
t('unlocked 回到 true', e.unlocked === true);
t('恢复也发了 statechange', notified === 2, `${notified}`);
off();
e.ctx.systemSuspend();
t('退订后不再通知', notified === 2, `${notified}`);

// ---------------------------------------------------------------- 6
console.log('\n6) WebKit：resume() 先 resolve、状态稍后才翻成 running');
resumeLagMs = 120;
e = new AudioEngine();
gestureAllowed = true;
const t0 = Date.now();
const lagged = await e.tryResume();
t('等到状态落定，没有误判成失败', lagged === true, `${lagged}`);
t(`确实等了（${Date.now() - t0}ms）`, Date.now() - t0 >= 100);
t('上报 ready', reportedAudioState(e) === 'ready');

console.log('\n7) 状态一直不翻 → 超时后如实返回 false');
resumeLagMs = 5000; // 比 SETTLE_MS 长得多
e = new AudioEngine();
const t1 = Date.now();
t('返回 false', (await e.tryResume()) === false);
const waited = Date.now() - t1;
t(`在 400ms 上限附近就放弃了（${waited}ms）`, waited >= 380 && waited < 1200, `${waited}`);
t('上报 blocked', reportedAudioState(e) === 'blocked');

// ---------------------------------------------------------------- 8
console.log('\n8) 开播时 context 被挂起：必须先恢复，否则排在冻结的时钟上');
resumeLagMs = 0;
gestureAllowed = true;
e = new AudioEngine();
await e.tryResume();
t('先解锁成功', e.unlocked === true);
e.ctx.systemSuspend();
t('模拟静置被挂起', e.ctx.state === 'suspended');
// prepare 设好 token 和条目，然后开播
await e.prepare('tok', [{ idx: 0, hash: 'h', startMs: 0, durationMs: 1000, volume: 1 }]);
e.start('tok', Date.now() + 1000);
await new Promise((r) => setTimeout(r, 20));
t('★ start() 把它恢复了（不是默默排在冻结时钟上）', e.ctx.state === 'running',
  e.ctx.state);
e.stop();

// ---------------------------------------------------------------- 9
console.log('\n9) 诊断行：每种失败模式都要能从字符串里分辨出来');
resumeLagMs = 0;

// (a) 从来没有手势
gestureAllowed = false;
e = new AudioEngine();
await e.tryResume();
const a = audioDiagnostics(e, 0);
console.log('   (a) 没有手势          →', a);
t('(a) 报出 resume 被拒', a.includes('rejects=1'), a);
t('(a) gestures=0', a.includes('gestures=0'), a);
t('(a) ever=no', a.includes('ever=no'), a);

// (b) 手势收到了，resume 也没抛错，但状态迟迟不翻 —— 被我们等超时
gestureAllowed = true;
resumeLagMs = 9000;
e = new AudioEngine();
await e.tryResume();
const b = audioDiagnostics(e, 3);
console.log('   (b) 状态始终不翻      →', b);
t('(b) 报出 timeout 而不是 reject', b.includes('timeouts=1') && !b.includes('rejects='), b);
t('(b) 手势数记下来了', b.includes('gestures=3'), b);

// (c) iOS 的 AudioContext 配额耗尽，连创建都失败
resumeLagMs = 0;
const RealCtor = globalThis.window.AudioContext;
globalThis.window.AudioContext = class {
  constructor() {
    throw new Error('InvalidStateError: too many AudioContexts');
  }
};
e = new AudioEngine();
t('(c) 创建失败时 tryResume 返回 false 而不是抛错', (await e.tryResume()) === false);
const c = audioDiagnostics(e, 1);
console.log('   (c) 配额耗尽          →', c);
t('(c) state=none', c.includes('state=none'), c);
t('(c) 报出构造失败', c.includes('new AudioContext'), c);
t('(c) ctxs=0', c.includes('ctxs=0'), c);
globalThis.window.AudioContext = RealCtor;

// (d) 一切正常
gestureAllowed = true;
e = new AudioEngine();
await e.tryResume();
const d = audioDiagnostics(e, 1);
console.log('   (d) 正常解锁          →', d);
t('(d) 带版本号（拿到读数第一件事是确认代码版本）', d.startsWith('diag='), d);
t('(d) state=running ever=yes', d.includes('state=running') && d.includes('ever=yes'), d);
t('(d) 没有任何错误字段', !d.includes('rejects=') && !d.includes('timeouts=') && !d.includes('last='), d);
t('(d) 认出是 iPhone 上的 Chrome', d.includes('ua=iOS/Chrome-iOS/18.5'), d);
t('(d) 带上触摸点数和屏幕尺寸（UA 能被改写，这两个不能）',
  d.includes('touch5') && d.includes('393x852'), d);
t('(d) WebKit 没有 userActivation → n/a 本身也是信息', d.includes('active=n/a'), d);

console.log('\n9a) 解锁成功后要清掉上次的错误');
gestureAllowed = false;
e = new AudioEngine();
await e.tryResume();
t('无手势失败时记下了错误', audioDiagnostics(e, 0).includes('last='));
gestureAllowed = true;
await e.tryResume();
const healed = audioDiagnostics(e, 1);
console.log('   先失败后成功        →', healed);
t('★ 成功后不再带 last=（否则「一切正常」看着像出了问题）',
  !healed.includes('last='), healed);
t('但历史计数保留（rejects 仍在）', healed.includes('rejects=1'), healed);

console.log('\n9b) 「请求桌面版网站」会把 UA 改成 Macintosh，不能因此认成 Mac');
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    // iOS 上开了桌面版模式的真实形态：出现 Macintosh，但 CriOS 还在
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.98 Safari/604.1',
    maxTouchPoints: 5,
  },
});
gestureAllowed = true;
e = new AudioEngine();
await e.tryResume();
const desktopMode = audioDiagnostics(e, 1);
console.log('   桌面版模式的 iPhone   →', desktopMode);
t('★ 仍然认成 iOS，不是 mac', desktopMode.includes('ua=iOS/Chrome-iOS'), desktopMode);
t('触摸点数暴露了它是手机', desktopMode.includes('touch5'), desktopMode);

console.log('\n10) 丢弃只发生一次（iOS 每页最多 4 个 AudioContext）');
gestureAllowed = false;
e = new AudioEngine();
await e.tryResume();
e.discardIfLocked();
const after1 = e.diag.contexts;
await e.tryResume();
e.discardIfLocked();
await e.tryResume();
e.discardIfLocked();
t('反复探测失败也不会无限创建 context', e.diag.contexts <= after1 + 1,
  `创建了 ${e.diag.contexts} 个`);
t('丢弃计数封顶在 1', e.diag.discarded === 1, `${e.diag.discarded}`);

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
