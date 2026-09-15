'use client';

import { audioUrl } from './api';
import type { ScheduleItem } from './types';

const LOOKAHEAD_SEC = 20; // 提前这么久把音频挂到 Web Audio 的时间线上
const PREFETCH_AHEAD = 8; // 窗口之外再预解码几条，滚动向前
// resume() 之后等状态落定的上限：WebKit 上状态翻成 running 会晚于 resume() 返回。
// 给足一点 —— 等一秒再报「被拦住了」无所谓，等不够就会把成功误判成失败。
const SETTLE_MS = 1000;

// 诊断行的版本号。每次改动这行的字段就 +1 —— 手机上拿到一条读数时，第一件事
// 是确认它来自哪一版代码，否则会拿着旧版的输出去推断新版的行为。
const DIAG_VERSION = 3;

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
 * 一行诊断，直接显示在设备自己的界面上。
 *
 * iOS 上「解锁不了」有好几种原因，从外部完全分不清：手势事件没收到？resume()
 * 被拒？状态翻得太慢被等超时？还是 AudioContext 配额耗尽连创建都失败？
 * 让设备自己把这些报出来，比继续推断快得多。
 */
export function audioDiagnostics(engine: AudioEngine, gestures: number) {
  const d = engine.diag;
  const bits = [
    `diag=${DIAG_VERSION}`,
    `state=${engine.ctxState}`,
    `ever=${engine.everUnlocked ? 'yes' : 'no'}`,
    `tries=${d.attempts}`,
    `ctxs=${d.contexts}`,
    `gestures=${gestures}`,
    // 页面有没有「粘性激活」。WebKit 不实现这个 API，所以 n/a 本身也是信息 ——
    // 它说明底层引擎是 WebKit（iOS 上的 Chrome 也是），而不是真 Chromium。
    `active=${activation()}`,
  ];
  if (d.ctor && d.ctor !== 'AudioContext') bits.push(`ctor=${d.ctor}`);
  if (d.resumeRejects) bits.push(`rejects=${d.resumeRejects}`);
  if (d.timeouts) bits.push(`timeouts=${d.timeouts}`);
  if (d.discarded) bits.push(`dropped=${d.discarded}`);
  if (d.lastError) bits.push(`last=${d.lastError}`);
  bits.push(`ua=${uaMarker()}`);
  return bits.join('  ');
}

/** 播放链路的实况。只在真的开播过之后才有意义。 */
export function playbackDiagnostics(engine: AudioEngine) {
  const p = engine.play;
  const bits = [`assigned=${p.assigned}`, `decoded=${p.decoded}`, `scheduled=${p.scheduled}`];
  if (p.decodeFails) bits.push(`decodeFails=${p.decodeFails}`);
  if (p.skippedMuted) bits.push(`muted=${p.skippedMuted}`);
  if (p.skippedLate) bits.push(`late=${p.skippedLate}`);
  if (p.lastError) bits.push(`playErr=${p.lastError}`);
  if (engine.diag.mediaPrimeError) bits.push(`mediaPrime=${engine.diag.mediaPrimeError}`);
  return bits.join('  ');
}

/**
 * 一小段全是 0 的 WAV。用来把 iOS 的音频会话类别切成 playback ——
 * 生成字节而不是写死 data URI，是因为 0 长度的 WAV 有些实现会直接拒收。
 */
let silentUrl = '';
function silentWavUrl() {
  if (silentUrl) return silentUrl;
  const rate = 8000;
  const samples = rate / 10; // 0.1 秒
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const tag = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 单声道
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, samples * 2, true);
  silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return silentUrl;
}

/**
 * 是不是 iOS 设备。
 *
 * 光看 iPhone/iPad 不够：开了「请求桌面版网站」之后 UA 会变成 Macintosh，
 * 所以补一条 —— 说自己是 Mac 但有多个触摸点的，那是 iPad/iPhone。
 */
export function isIosLike() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/CriOS|FxiOS|EdgiOS|iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

function activation() {
  const ua = (navigator as any).userActivation;
  if (!ua) return 'n/a';
  return `${ua.hasBeenActive ? 'been' : 'never'}/${ua.isActive ? 'now' : 'idle'}`;
}

/**
 * 只取能区分设备和引擎的那几段，不是整条 UA。
 *
 * 顺序有讲究：iOS 上开了「请求桌面版网站」之后 UA 里会出现 Macintosh，
 * 所以必须先看 CriOS/FxiOS/EdgiOS 这类只属于 iOS 的标记，否则会把手机认成 Mac。
 * 光看 UA 还是可能被改，所以另外报触摸点数和屏幕尺寸 —— 那两个骗不了人。
 */
function uaMarker() {
  const ua = navigator.userAgent;
  const iosBrowser = /CriOS/.test(ua)
    ? 'Chrome-iOS'
    : /FxiOS/.test(ua)
      ? 'Firefox-iOS'
      : /EdgiOS/.test(ua)
        ? 'Edge-iOS'
        : null;

  const bits = [];
  if (iosBrowser || /iPhone|iPad|iPod/.test(ua)) bits.push('iOS');
  else if (/Android/.test(ua)) bits.push('Android');
  else if (/Macintosh/.test(ua)) bits.push('mac');
  else if (/Windows/.test(ua)) bits.push('win');

  if (iosBrowser) bits.push(iosBrowser);
  else if (/Chrome\//.test(ua)) bits.push('Chrome');
  else if (/Firefox\//.test(ua)) bits.push('Firefox');
  else if (/Safari\//.test(ua)) bits.push('Safari');

  const ver = ua.match(/(?:iPhone )?OS (\d+[_.]\d+)/);
  if (ver) bits.push(ver[1].replace('_', '.'));

  // UA 能被「请求桌面版」改写，这两个不能
  const touch = navigator.maxTouchPoints ?? 0;
  bits.push(`touch${touch}`);
  if (typeof screen !== 'undefined') bits.push(`${screen.width}x${screen.height}`);

  return bits.join('/') || 'unknown';
}

const errText = (err: unknown) =>
  err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 120) : String(err).slice(0, 120);

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
  private mediaPrimed = false;
  private troubleSeen = new Set<string>();

  /** 播放链路出问题时喊一声。静默失败是最糟的结果 —— 没声音又没解释。 */
  onTrouble: ((message: string) => void) | null = null;

  /**
   * 播放链路的实况计数。
   *
   * 「状态一切正常但就是不出声」有好几种原因，从外面一个都看不出来：这台设备
   * 根本没分到台词？音频取不下来？iOS 的 decodeAudioData 拒了？还是排期算晚了
   * 全被跳过？所以每一步都记下来。
   */
  readonly play = {
    assigned: 0, // 这台设备分到几条
    decoded: 0,
    decodeFails: 0,
    scheduled: 0, // 真的挂到时间线上了
    skippedMuted: 0, // 角色音量为 0
    skippedLate: 0, // 排期已经过去了，整条来不及了
    lastError: '',
  };

  /**
   * 诊断计数。iOS 上解锁失败的原因很难从外部看出来（是手势没收到？resume 被拒？
   * 还是状态翻得太慢被我们等超时了？），所以把这些都记下来显示到界面上。
   */
  readonly diag = {
    mediaPrimeError: '', // 静音 <audio> 没能起播时的原因
    contexts: 0, // 创建过几个 AudioContext（iOS 每页上限 4 个）
    attempts: 0, // tryResume 被调用了几次
    resumeRejects: 0, // resume() 抛错几次（没有手势时的正常表现）
    timeouts: 0, // resume() 没抛错但状态始终没翻成 running
    discarded: 0,
    ctor: '',
    lastError: '',
  };

  /** AudioContext 当前的状态，没有 context 时是 none */
  get ctxState() {
    return this.ctx ? this.ctx.state : 'none';
  }

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

  /** 同一个原因只喊一次 —— 一条脚本几百句，不能刷几百个提示 */
  private trouble(msg: string) {
    if (this.troubleSeen.has(msg)) return;
    this.troubleSeen.add(msg);
    this.onTrouble?.(msg);
  }

  /**
   * 先放一段无声的 <audio>，把 iOS 的音频会话类别切成 playback。
   *
   * iOS 上这两条路走的是不同的会话类别：<audio> 用 playback，无视侧面的静音
   * 拨片；AudioContext 用 ambient，会被静音拨片直接掐掉。于是会出现「角色试听
   * 有声（那是 <audio>）、真念无声（那是 Web Audio）」，而 context 状态一切正常。
   * 先播一次 <audio> 能把类别切过去，让 Web Audio 也能出声。
   *
   * 必须在用户手势的同一个同步周期里调用，所以这里不 await。
   */
  private primeMediaSession() {
    if (this.mediaPrimed || typeof Audio === 'undefined') return;
    try {
      const el = new Audio(silentWavUrl());
      el.volume = 1; // 样本全是 0，本来就没声音
      const p = el.play();
      this.mediaPrimed = true;
      void p
        ?.then(() => {
          el.pause();
        })
        .catch((err) => {
          this.mediaPrimed = false;
          this.diag.mediaPrimeError = errText(err);
        });
    } catch (err) {
      this.diag.mediaPrimeError = errText(err);
    }
  }

  /** 可能返回 null —— iOS 每页最多 4 个 AudioContext，超了构造函数会抛 */
  private context(): AudioContext | null {
    if (!this.ctx) {
      try {
        const Ctor = window.AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) {
          this.diag.lastError = 'no AudioContext in this browser';
          return null;
        }
        this.diag.ctor = window.AudioContext ? 'AudioContext' : 'webkitAudioContext';
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.diag.contexts++;
        const notify = () => this.stateWatchers.forEach((fn) => fn());
        this.ctx!.addEventListener?.('statechange', notify);
        // 老 Safari 只有 onstatechange
        if (!this.ctx!.addEventListener) (this.ctx as any).onstatechange = notify;
      } catch (err) {
        this.diag.lastError = `new AudioContext: ${errText(err)}`;
        this.ctx = null;
        return null;
      }
    }
    return this.ctx;
  }

  /**
   * 没解锁成功就把这个 context 丢掉。
   *
   * iOS 上在用户手势之外创建的 AudioContext 有时再也 resume 不起来，下次手势里
   * 新建一个反而更可靠。已经 running 过的不动 —— 那里面挂着排好期的音频。
   */
  discardIfLocked() {
    // 只丢一次。iOS 每页最多 4 个 AudioContext，反复创建/关闭会把配额耗光，
    // 之后 new AudioContext() 直接抛错 —— 那比原来的问题更糟。
    if (!this.ctx || this.ever || this.running || this.diag.discarded > 0) return;
    this.diag.discarded++;
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
    this.diag.attempts++;
    // 同步发起，不 await —— iOS 只认用户手势那一个同步周期
    this.primeMediaSession();
    const ctx = this.context();
    if (!ctx) return false;

    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch (err) {
      // 没有手势时浏览器会拒绝，属于预期
      this.diag.resumeRejects++;
      this.diag.lastError = `resume: ${errText(err)}`;
    }
    // WebKit 上 resume() 可能先 resolve、状态稍后才翻成 running，
    // 立刻去读 state 会误判成失败
    if (!(await this.settle(ctx, SETTLE_MS))) {
      this.diag.timeouts++;
      return false;
    }

    this.ever = true;
    // 成功了就把上次的错误清掉。手机上第一次无手势探测必定被拒，那条
    // NotAllowedError 留着会让「一切正常」看起来像出了问题。
    this.diag.lastError = '';
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
      if (!res.ok) throw new Error(`could not fetch audio (HTTP ${res.status})`);
      const arr = await res.arrayBuffer();
      let buf: AudioBuffer;
      try {
        buf = await this.ctx!.decodeAudioData(arr);
      } catch (err) {
        // iOS 的 decodeAudioData 比别家挑，而且拒绝时给的理由常常是空的
        throw new Error(`this browser could not decode the audio (${errText(err) || 'no reason given'})`);
      }
      this.buffers.set(hash, buf);
      this.play.decoded++;
      return buf;
    })()
      .catch((err) => {
        this.play.decodeFails++;
        this.play.lastError = errText(err);
        this.trouble(`Audio problem on this device — ${errText(err)}`);
        throw err;
      })
      .finally(() => this.inflight.delete(hash));

    this.inflight.set(hash, task);
    return task;
  }

  /**
   * 预加载开头几条，让 play:go 一到就能出声。
   * 返回 false 表示还没解锁，没法解码。
   */
  async prepare(token: string, myItems: ScheduleItem[], count = 4) {
    this.token = token;
    this.troubleSeen.clear();
    Object.assign(this.play, {
      assigned: myItems.length,
      decoded: 0,
      decodeFails: 0,
      scheduled: 0,
      skippedMuted: 0,
      skippedLate: 0,
      lastError: '',
    });
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
        else this.play.skippedMuted++;
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
      if (offset >= buf.duration - 0.05) {
        this.play.skippedLate++;
        return;
      }
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
    this.play.scheduled++;

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
