'use client';

import { audioUrl } from './api';
import type { ScheduleItem } from './types';

const LOOKAHEAD_SEC = 20; // 提前这么久把音频挂到 Web Audio 的时间线上
const PREFETCH_AHEAD = 8; // 窗口之外再预解码几条，滚动向前
// resume() 之后等状态落定的上限：WebKit 上状态翻成 running 会晚于 resume() 返回
const SETTLE_MS = 400;

type Tracked = ScheduleItem & { _scheduled?: boolean; _done?: boolean };

/**
 * 上报给房间的声音状态。
 *
 * 「此刻能不能播」和「要不要提示用户」是两件事：手机上 AudioContext 会被反复挂起
 * （切后台、锁屏、切 App 都会），但只要解锁过一次，用户随手碰一下页面就恢复了 ——
 * 这种情况不该报成 blocked，否则设备列表会永远卡在「audio blocked」，而声音其实
 * 出得来。真正决定能不能播的地方用实时的 engine.unlocked。
 */
export function reportedAudioState(engine: AudioEngine): 'ready' | 'blocked' {
  return engine.unlocked || engine.everUnlocked ? 'ready' : 'blocked';
}

/**
 * 用 Web Audio 而不是 <audio> 播放：source.start(when) 是采样级精度的，
 * 而 <audio>.play() 的启动抖动有几十毫秒 —— 抢话的 1-3 秒重叠会被抖没。
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private inflight = new Map<string, Promise<AudioBuffer>>();
  private items: Tracked[] = [];
  private active = new Set<AudioBufferSourceNode>();
  private originCtxTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private token = '';
  private running = false;

  private ever = false;
  private stateWatchers = new Set<() => void>();

  /** 此刻能不能真的出声 */
  get unlocked() {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * 这台设备是否曾经解锁成功过。
   *
   * 手机上 AudioContext 会被反复挂起（切后台、锁屏、切 App），但只要解锁过一次，
   * 之后用户随便碰一下页面就会自己恢复 —— 不需要再提示。所以「当前是否 running」
   * 用来决定能不能播，「曾不曾解锁过」用来决定要不要提示。
   */
  get everUnlocked() {
    return this.ever;
  }

  /** 订阅 AudioContext 自己的状态变化（挂起、恢复、iOS 的 interrupted） */
  onStateChange(fn: () => void) {
    this.stateWatchers.add(fn);
    return () => this.stateWatchers.delete(fn);
  }

  private context() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      const notify = () => this.stateWatchers.forEach((fn) => fn());
      this.ctx!.addEventListener?.('statechange', notify);
      // 老 Safari 只有 onstatechange
      if (!this.ctx!.addEventListener) (this.ctx as any).onstatechange = notify;
    }
    return this.ctx!;
  }

  /**
   * 没解锁成功就把这个 context 丢掉。
   *
   * iOS 上在用户手势之外创建的 AudioContext 有时再也 resume 不起来，下次手势里
   * 新建一个反而更可靠。已经 running 过的不动 —— 那里面挂着排好期的音频。
   */
  discardIfLocked() {
    if (!this.ctx || this.ever || this.running) return;
    const dying = this.ctx;
    this.ctx = null;
    void dying.close().catch(() => {});
  }

  /**
   * 试着把 AudioContext 弄成 running。
   *
   * 不需要「必须是那个按钮的点击」—— 浏览器认的是任意用户手势，而且如果本站
   * 互动度够高（Chrome 的 Media Engagement Index）或这个页面已经交互过，
   * 连手势都不需要。所以这个方法可以随便调：能成就成，不能成就还是 suspended，
   * 不会抛错、也不会有副作用。
   */
  async tryResume(): Promise<boolean> {
    const ctx = this.context();
    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      /* 没有手势时浏览器会拒绝，属于预期 */
    }
    // WebKit 上 resume() 可能先 resolve、状态稍后才翻成 running，
    // 立刻去读 state 会误判成失败
    if (!(await this.settle(ctx, SETTLE_MS))) return false;

    this.ever = true;
    // 播一段无声，彻底解锁 iOS/Safari
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start();
    } catch {
      /* 无所谓 */
    }
    return true;
  }

  /** 等状态真的翻成 running，最多等 ms 毫秒。返回最终是否 running。 */
  private settle(ctx: AudioContext, ms: number) {
    return new Promise<boolean>((resolve) => {
      if (ctx.state === 'running') return resolve(true);
      let timer: ReturnType<typeof setTimeout>;
      const stop = (ok: boolean) => {
        clearTimeout(timer);
        ctx.removeEventListener?.('statechange', onChange);
        resolve(ok);
      };
      const onChange = () => {
        if (ctx.state === 'running') stop(true);
      };
      ctx.addEventListener?.('statechange', onChange);
      timer = setTimeout(() => stop(ctx.state === 'running'), ms);
    });
  }

  /** @deprecated 用 tryResume()，语义一样但名字不再暗示「必须点按钮」 */
  async unlock() {
    return this.tryResume();
  }

  private async ensureBuffer(hash: string): Promise<AudioBuffer> {
    const hit = this.buffers.get(hash);
    if (hit) return hit;
    const pending = this.inflight.get(hash);
    if (pending) return pending;

    const task = (async () => {
      const res = await fetch(audioUrl(hash));
      if (!res.ok) throw new Error(`Could not fetch audio ${hash}`);
      const arr = await res.arrayBuffer();
      const buf = await this.ctx!.decodeAudioData(arr);
      this.buffers.set(hash, buf);
      return buf;
    })().finally(() => this.inflight.delete(hash));

    this.inflight.set(hash, task);
    return task;
  }

  /**
   * 预加载开头几条，让 play:go 一到就能出声。
   * 返回 false 表示还没解锁，没法解码。
   */
  async prepare(token: string, myItems: ScheduleItem[], count = 4) {
    this.token = token;
    this.items = myItems
      .slice()
      .sort((a, b) => a.startMs - b.startMs)
      .map((i) => ({ ...i }));
    this.buffers.clear();

    if (!this.ctx) return false;

    const head = this.items.slice(0, count);
    await Promise.allSettled(head.map((i) => this.ensureBuffer(i.hash)));
    return true;
  }

  /** @param startAtLocalMs 换算到本机时钟后的开播时刻（epoch ms） */
  start(token: string, startAtLocalMs: number) {
    if (!this.ctx || token !== this.token) return;
    // 兜底：挂起状态下 currentTime 不推进，排上去的东西永远不会响。
    // 正常情况下 prepare 阶段已经恢复过了，这里只是防最后一刻又被挂起。
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
    this.running = true;
    const deltaSec = (startAtLocalMs - Date.now()) / 1000;
    this.originCtxTime = this.ctx.currentTime + deltaSec;
    this.tick();
    this.timer = setInterval(() => this.tick(), 500);
  }

  private tick() {
    if (!this.ctx || !this.running) return;
    const now = this.ctx.currentTime;

    let windowEnd = -1;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (item._done) continue;

      const startCtx = this.originCtxTime + item.startMs / 1000;
      const endCtx = startCtx + item.durationMs / 1000;

      if (endCtx < now - 0.05) {
        item._done = true;
        this.buffers.delete(item.hash); // 放完就放掉解码后的 PCM，长脚本不会把内存吃爆
        continue;
      }
      if (startCtx > now + LOOKAHEAD_SEC) {
        windowEnd = i;
        break;
      }
      if (!item._scheduled) {
        item._scheduled = true;
        // 静音的角色连解码都省了，只是安静地占着这段时间
        if ((item.volume ?? 1) > 0) void this.scheduleItem(item, startCtx);
      }
    }

    // 窗口外再往前预解码几条
    if (windowEnd >= 0) {
      for (const item of this.items.slice(windowEnd, windowEnd + PREFETCH_AHEAD)) {
        if (!item._done) void this.ensureBuffer(item.hash).catch(() => {});
      }
    }
  }

  private async scheduleItem(item: Tracked, startCtx: number) {
    const token = this.token;
    let buf: AudioBuffer;
    try {
      buf = await this.ensureBuffer(item.hash);
    } catch {
      return;
    }
    if (!this.ctx || !this.running || token !== this.token) return;

    const now = this.ctx.currentTime;
    let when = startCtx;
    let offset = 0;

    if (startCtx < now) {
      // 迟到了（页面卡了一下 / 网络慢），从音频中间切进去，别整体后移
      offset = now - startCtx;
      if (offset >= buf.duration - 0.05) return;
      when = now + 0.02;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    // 角色音量是播放时的增益（模拟离收音设备的远近），和抢话时的压音量相乘。
    // 它不进音频哈希 —— 调音量是即时的，不需要重新合成。
    const volume = item.volume ?? 1;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, Math.max(when, now));

    if (item.duckFromMs != null) {
      // 这一句被下一句抢了：从重叠开始处淡到 volume × duckGain
      const duckAt = startCtx + item.duckFromMs / 1000;
      const ducked = volume * item.duckGain;
      if (duckAt > now + 0.02) {
        gain.gain.setValueAtTime(volume, duckAt);
        gain.gain.linearRampToValueAtTime(ducked, duckAt + 0.25);
      } else {
        gain.gain.setValueAtTime(ducked, Math.max(when, now));
      }
    }

    src.connect(gain);
    gain.connect(this.ctx.destination);
    src.start(when, offset);

    this.active.add(src);
    src.onended = () => this.active.delete(src);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const src of this.active) {
      try {
        src.stop();
      } catch {
        /* 已经停了 */
      }
    }
    this.active.clear();
    this.items = [];
    this.buffers.clear();
  }
}
