'use client';

// 环境音：把你给的 YouTube 链接塞进隐藏的 IFrame Player，只出声不出画。
// 浏览器的自动播放策略要求先有一次用户手势，所以流程是
//   init()（页面加载时静默建好 player） → arm()（用户点一下按钮）→ play()（开始 room 时程序触发）

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export function parseYouTubeId(raw: string): { id: string; start: number } | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim().startsWith('http') ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return /^[\w-]{11}$/.test(raw.trim()) ? { id: raw.trim(), start: 0 } : null;
  }

  const start = Number(url.searchParams.get('t')?.replace(/s$/, '') || 0) || 0;
  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1);
    return /^[\w-]{11}$/.test(id) ? { id, start } : null;
  }
  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    const v = url.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return { id: v, start };
    const m = url.pathname.match(/\/(?:embed|live|shorts|v)\/([\w-]{11})/);
    if (m) return { id: m[1], start };
  }
  return null;
}

let apiPromise: Promise<void> | null = null;

function loadApi(): Promise<void> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve, reject) => {
    if (window.YT?.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.onerror = () => reject(new Error('YouTube 播放器脚本加载失败（网络可能访问不到 youtube.com）'));
    document.head.appendChild(tag);
    setTimeout(() => reject(new Error('YouTube 播放器加载超时')), 15000);
  });
  return apiPromise;
}

export class AmbiencePlayer {
  private player: any = null;
  private videoId = '';
  private ready = false;
  private armed = false;
  private wantVolume = 25;

  get isReady() {
    return this.ready;
  }
  get isArmed() {
    return this.armed;
  }

  async init(container: HTMLElement, url: string, volume: number) {
    const parsed = parseYouTubeId(url);
    if (!parsed) throw new Error('这个链接解析不出 YouTube 视频 ID');
    this.wantVolume = volume;

    if (this.player && this.videoId === parsed.id) {
      this.setVolume(volume);
      return;
    }

    await loadApi();
    this.destroy();
    this.videoId = parsed.id;
    this.ready = false;

    const host = document.createElement('div');
    container.appendChild(host);

    await new Promise<void>((resolve) => {
      this.player = new window.YT.Player(host, {
        height: '1',
        width: '1',
        videoId: parsed.id,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          loop: 1,
          playlist: parsed.id, // loop=1 对单个视频必须配 playlist
          start: parsed.start,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            this.ready = true;
            this.player.setVolume(this.wantVolume);
            resolve();
          },
          onStateChange: (e: any) => {
            // videos 偶尔会在结尾停住而不循环，兜一下
            if (e.data === window.YT.PlayerState.ENDED) this.player.seekTo(parsed.start, true);
          },
        },
      });
    });
  }

  /** 必须在用户手势里同步调用 */
  arm() {
    if (!this.player || !this.ready) return false;
    this.player.unMute();
    this.player.setVolume(this.wantVolume);
    this.player.playVideo();
    setTimeout(() => {
      try {
        this.player.pauseVideo();
      } catch {
        /* noop */
      }
    }, 250);
    this.armed = true;
    return true;
  }

  play() {
    if (!this.player || !this.ready) return;
    this.player.unMute();
    this.player.setVolume(this.wantVolume);
    this.player.playVideo();
  }

  stop() {
    if (!this.player || !this.ready) return;
    try {
      this.player.pauseVideo();
    } catch {
      /* noop */
    }
  }

  setVolume(v: number) {
    this.wantVolume = v;
    if (this.player && this.ready) this.player.setVolume(v);
  }

  destroy() {
    try {
      this.player?.destroy();
    } catch {
      /* noop */
    }
    this.player = null;
    this.ready = false;
    this.armed = false;
  }
}
