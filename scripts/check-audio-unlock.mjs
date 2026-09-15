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

const { AudioEngine, reportedAudioState } = await import('../lib/audioEngine.ts');

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

console.log(`\n${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
