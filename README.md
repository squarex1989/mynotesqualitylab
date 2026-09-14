# ReadRoom

上传一份 transcript，把里面的角色分给屋子里的每台电脑，让它们用各自的音色、语气、口音把这场对话读出来。

TTS 用 Fish Audio S2.1-Pro Free，直连官方 API（`api.fish.audio`）。

- **创建 / 加入 room** —— 6 位房间号，其他电脑输号进来
- **角色设定** —— 每个 speaker 有音色（从 fish.audio 公开库拉，带描述和标签）+ 年龄感 / 语气 / 口音 / 语速 / 情绪 / 说话习惯，默认随机；风格标签也可以直接手写。性别由音色本身决定，不单独设
- **设备分配** —— 一个角色对一台设备，一台设备可以拿多个角色；只有房主一台机器也能跑
- **房间基调** —— 有序 / 混乱（定时抢话，被抢的那句同时压低音量）× 安静 / 嘈杂（指定一台设备用 YouTube 链接放咖啡馆或机场环境音）
- **合成是显式的一步** —— 上传和改设定都不会触发 TTS，房主把所有角色确认好之后点「合成音频」才开跑
- **音频只合成一次** —— 按「模型 + 音色 + 风格标签 + 文本」的哈希存盘，改哪个角色就只重跑哪个角色；改回用过的设定直接命中缓存，一次 API 都不发

---

## 跑起来

需要 **Node ≥ 22.13**（用到内置的 `node:sqlite`，所以没有任何需要编译的原生依赖；
22.13 / 23.4 之前这个模块还藏在 `--experimental-sqlite` 标志后面）。

```bash
npm install
```

在项目根目录建一个 `.env`（注意把下面这行换成你自己的 key，别原样粘贴）：

```
FISH_API_KEY=...
```

然后：

```bash
npm run dev
```

打开 http://localhost:3000 。启动日志里会列出局域网地址，同一个 Wi-Fi 下的其他电脑用那个地址就能加入。

### 全部环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FISH_API_KEY` | 必填 | 只在服务端使用，永远不会下发到浏览器 |
| `FISH_MODEL` | `s2.1-pro-free` | 见下方「模型」 |
| `FISH_MP3_BITRATE` | `128` | 64 / 128 / 192 |
| `FISH_LATENCY` | `normal` | `normal` 质量优先，`balanced` 更快 |
| `MAX_TTS_CHARS` | `800` | 单句字数上限，超过就在句号处切开 |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | SQLite 和生成的 mp3 都在这里。部署时指向挂载磁盘 |
| `TTS_CONCURRENCY` | `4` | 同时并发的 TTS 请求数 |
| `FISH_BASE_URL` | `https://api.fish.audio` | 本地测试时指向下面的 mock |

### 模型

`FISH_MODEL` 决定用哪个模型，它走的是 `model` 请求头（**写进 body 会被静默忽略**，
然后你拿到的是默认模型却以为选择生效了）。

| 值 | 说明 |
| --- | --- |
| `s2.1-pro-free`（默认） | 和 `s2.1-pro` 同一个模型、同样质量和语言覆盖，$0。走 Fair Use，没有延迟和可用性保证 |
| `s2.1-pro` | 付费版，$15 / 百万 UTF-8 字节。要延迟和可用性保证时用它 |
| `s2-pro` | 上一代 |
| `s1` | 更老一代，风格标签用圆括号且标签集固定 |

换付费版只需要改这一个环境变量。注意**模型名进了音频缓存的哈希**，所以换模型会让
已有音频全部失效、需要重新合成一遍。

免费档是 Fish 官方说明的「初期免费」，他们保留调整的权利。

### 音色表

Fish 没有官方的具名音色表 —— `voice` 是 [fish.audio](https://fish.audio) 音色库里的 32 位
十六进制 `reference_id`。跑一次这个从公开库拉一份带描述、标签、语言的表：

```bash
node --env-file-if-exists=.env scripts/fetch-fish-voices.mjs
```

```bash
# 只要中文音色，取 40 个
node --env-file-if-exists=.env scripts/fetch-fish-voices.mjs --language zh --limit 40
```

结果写进 `data/voices.fish.json`，服务会自动读（改了文件不用重启）。**跑完之后服务本身
不再访问 api.fish.audio 的音色接口**，只用合成接口。

没跑过的话会用一份内置兜底表（几个公开示例音色），界面上会提示。

### 对着真实 API 自检

```bash
node --env-file-if-exists=.env scripts/check-fish.mjs
```

会验证：音色库字段齐全性、msgpack 请求、mp3/wav/pcm/opus 各格式、`prosody.speed`
是否真的改变时长、`[方括号标签]` 会不会被念出来、不存在的 `reference_id` 会不会被拒。

### 不花钱地测试

`scripts/mock-tts.js` 是个假 TTS，返回的静音 PCM 和真实接口格式一致
（`audio/pcm;rate=24000;channels=1`），时长按文本长度估算，所以排期、抢话、重叠、
缓存这些逻辑都能真实验证。它也一样拒绝 `response_format=mp3`，免得本地测试掩盖真实行为：

```bash
node scripts/mock-tts.js
```

另开一个终端：

```bash
FISH_API_KEY=mock-key-for-local-testing-only FISH_BASE_URL=http://127.0.0.1:4010 npm run dev
```

---

## 用法

1. 首页给这台设备起个名字（房主按设备名分配角色），点 **创建 room**
2. 其他电脑打开同一个地址，输房间号 **加入 room**
3. **每台设备都要点一次「启用声音」** —— 浏览器不允许网页在没有用户手势的情况下出声。谁没点，房主在「设备」列表和开场面板里都看得到
4. 房主粘贴或拖入 transcript。提交前会实时预览解析结果：几句、几个说话人、前 12 句长什么样
   - 认错的说话人（比如把「补充一句：」当成了人名）可以点掉，那一行会并回上一句
   - **transcript 一旦提交，这个房间就锁定了，不能再替换** —— 所以才有这一步预览
5. 调角色的音色和语气、把角色分到不同设备、选有序 / 混乱、安静 / 嘈杂
6. 确认好之后点 **合成音频** —— 到这一步才会真的调 API。上传和改设定都不会触发 TTS，
   免得每动一次下拉框就烧一轮钱
7. 进度到 100% 后按钮变成 **开始 room**
8. 之后再改某个角色，进度会回落，按钮变回「合成音频（N 句）」，而且只重跑变过的那个角色

支持的 transcript 格式：

```
Alice: 我们先过一下上周的数据。
Bob: 等一下，我这边的图还没刷出来。
```

```
00:00:05 Alice Wang: Hello everyone          # Zoom 导出
[00:12:33] 张三: 这个方案我有意见              # 方括号时间戳
Alice (00:12:33): hi there                   # 名字后挂时间戳

张三  00:00:12                                # 腾讯会议：名字一行，正文在下一行
这个季度的目标是什么？
```

SRT / VTT 字幕和 `[{"speaker":"A","content":"..."}]` 这种 JSON 也认。时间戳一律自动剥掉。

---

## 几个设计上的选择

**为什么用 msgpack 而不是 JSON** —— Fish 官方 SDK 发的是 `Content-Type: application/msgpack`，
body 用 msgpack 打包，模型名走 `model` 请求头而不在 body 里。这么做是因为 `references`
（声音克隆的参考音频）里装的是原始字节。我们只用 `reference_id`、理论上 JSON 也够，
但既然 SDK 走 msgpack 就照着来 —— 这条路是确定能用的。

**语速走参数、其它走标签** —— Fish 的风格控制没有独立参数，靠 `[方括号标签]` 拼在正文
前面（标签不会被读出来）。但语速是例外：`prosody.speed` 是真参数（0.5–2.0），比写
"speaking slowly" 让模型自己体会可靠，所以语速那一项不进标签。

**为什么用 Web Audio 而不是 `<audio>`** —— `source.start(when)` 是采样级精度的；`<audio>.play()` 的启动抖动有几十毫秒，抢话那 1–3 秒的重叠会被抖没。

**设备之间怎么对时** —— 每台设备连上来之后跑 6 轮 ping，取 RTT 最小的一次算时钟偏移。房主点开始时服务端不立刻开播，而是先发 `play:prepare` 让各设备预加载开头几条，全部报就绪（或 15 秒超时）之后才发带绝对时间戳的 `play:go`。

**长脚本不会把内存吃爆** —— 客户端只提前 20 秒把音频挂到 Web Audio 时间线上，播完就释放解码后的 PCM，再滚动预取后面几条。

**改设定为什么能不重复花钱** —— 音频的身份是 `sha256(模型 + 音色 + 风格标签 + 文本)`，内容寻址、跨房间共享。改一个角色的口音只会重跑它自己的句子；改回来则一次请求都不发，因为旧文件还在。合成本身是显式触发的，所以调设定的过程完全免费。

**为什么没有“性别”下拉** —— 性别已经由 `voice` 参数决定了（音色下拉里就标着男声 / 女声）。再在风格标签里写一句 "a male speaker" 只会和音色本身打架，让模型在两个信号之间摇摆。

---

## 部署

因为要跑 WebSocket 长连接（Socket.IO）和持久磁盘，**不能用 Vercel**。

### Railway（推荐）

仓库里有 `railway.json`，构建走 Nixpacks（`npm ci --include=dev` → `npm run build` → `npm start`）。

1. Railway → **New Project → Deploy from GitHub repo**，选这个仓库
2. **Variables** 里加两个：
   - `FISH_API_KEY` = 你的 key
   - `DATA_DIR` = `/data`
3. **Settings → Volumes → Add Volume**，Mount path 填 `/data`（不能省，见下）
4. **Settings → Networking → Generate Domain**，拿到公网地址

`PORT` 由 Railway 自动注入，代码直接读 `process.env.PORT`，不用配。

Node 版本由 `.nvmrc`（`24`）和 `package.json` 的 `engines` 决定。**别降到 22.13 以下** ——
`node:sqlite` 在那之前还需要 `--experimental-sqlite` 标志，服务会起不来。

> **为什么 Dockerfile 放在 `deploy/` 而不是根目录**
>
> Railway 一看到根目录有 `Dockerfile` 就会用它构建，而且这个行为盖过了 `railway.json`
> 里的 `builder: NIXPACKS`。所以 Dockerfile 挪到了 `deploy/`，让 Railway 没有东西可以
> 自动检测，只走 Nixpacks —— 那条路是本地验证过的 `npm ci → build → start`。
>
> 如果你确实想让 Railway 用 Docker 构建，把 `railway.json` 改成：
> `"builder": "DOCKERFILE", "dockerfilePath": "deploy/Dockerfile"`。

### Render

`render.yaml` 直接可用 —— 建一个 Blueprint 服务，在控制台填 `FISH_API_KEY`。
磁盘挂在 `/var/data`，`DATA_DIR` 已经指过去了。注意免费层没有持久磁盘。

### Fly.io / 自己的 VPS

用 `deploy/Dockerfile`，把一块卷挂到 `/data`：

```bash
fly launch --no-deploy --dockerfile deploy/Dockerfile
fly volumes create readroom_data --size 5
fly secrets set FISH_API_KEY=...
fly deploy
```

`fly.toml` 里加上：

```toml
[env]
  DATA_DIR = "/data"

[[mounts]]
  source = "readroom_data"
  destination = "/data"
```

**不管用哪家，一定要挂持久磁盘，而且 `DATA_DIR` 必须正好等于卷的挂载路径。**
路径取什么值都行（`/data`、`/var/data` 都可以），两边相等就行。

不挂卷不会报错 —— 目录会建在容器的临时层上，服务照样跑，只是每次重部署静默丢掉
全部音频。所以启动日志里会明说这块盘的状态：

```
数据目录: /var/data
          沿用上次的数据 · 137 个音频 · 这块盘首次使用于 2026-09-14T...
```

如果重部署之后还是显示「这是一块空盘」，就说明卷没挂上。

---

## 代码结构

```
server.js              自定义 Node server：Next + Express + Socket.IO 一个进程
server/
  db.js                node:sqlite 建表；音频文件路径
  parse.js             transcript 解析（纯文本 / 时间戳 / SRT / JSON）
  voices.js            音色目录、各维度选项、风格标签拼装、随机配置
  tts.js               Fish API 调用（msgpack）、内容寻址缓存、时长探测、限流重试
  generate.js          房间级的批量合成任务（限并发、推进度、跑完再扫一遍）
  schedule.js          把台词排成带绝对偏移的时间线（有序 / 抢话 / 压音量）
  rooms.js             房间、角色、设备、分配、设置的读写
  api.js               HTTP 接口（建房、上传、音频文件）
  realtime.js          Socket.IO：实时状态、房主操作、开播握手
lib/                   前端：socket hook、Web Audio 引擎、时钟同步、YouTube 环境音
components/            上传器、角色卡、设备面板、基调设置、台词、开场面板
scripts/
  mock-tts.js          本地假 Fish（msgpack + mp3），不花额度跑通链路
  fetch-fish-voices.mjs  从 fish.audio 公开库拉音色表
  check-fish.mjs       对着真实 API 自检
```
