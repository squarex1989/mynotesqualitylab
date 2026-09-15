# Transcript Reader

上传一份 transcript，把里面的角色分给屋子里的每台电脑，让它们用各自的音色、语气、口音把这场对话读出来。

TTS 用 Fish Audio S2.1-Pro Free，直连官方 API（`api.fish.audio`）。

- **创建 / 加入 room** —— 6 位房间号，其他电脑输号进来。房间可以起名（最多 20 个汉字 / 40 个字母），首页能看到自己建过的房间、改名、删除
- **角色设定** —— 每个 speaker 四项：音色（从 fish.audio 挑）、语速（Normal / Fast）、音量（模拟离收音设备的远近，默认 100%，可降到 20%，0 为静音）、由哪台设备读。角色之间的差异靠换音色，不靠给同一个音色贴风格标签
- **设备分配** —— 一个角色对一台设备，一台设备可以拿多个角色；只有房主一台机器也能跑
- **房间基调** —— 有序 / 混乱（定时抢话，被抢的那句同时压低音量）× 安静 / 嘈杂（指定一台设备用 YouTube 链接放咖啡馆或机场环境音，两个场景各有默认链接，音量默认 10%）
- **合成是显式的一步** —— 上传和改设定都不会触发 TTS，房主把所有角色确认好之后点「合成音频」才开跑
- **界面是英文的** —— 代码注释和这份 README 还是中文
- **音频只合成一次** —— 按「模型 + 音色 + 语速 + 文本」的哈希存盘，改哪个角色就只重跑哪个角色；改回用过的设定直接命中缓存，一次 API 都不发

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

`FISH_MODEL` 只是**新房间的默认值** —— 每个房间在「Room settings」里都能自己切 Free / Paid。
注意**模型名进了音频缓存的哈希**，所以换模型会让那个房间已有的音频失效、需要重新合成；
但旧音频不删，切回去仍然命中缓存。

免费档是 Fish 官方说明的「初期免费」，他们保留调整的权利。

### 音色表

Fish 没有官方的具名音色表 —— `voice` 是 [fish.audio](https://fish.audio) 音色库里的
32 位十六进制 `reference_id`。公开库有一千多个音色，都带 `description` / `tags` /
`languages` / 试听样本。有两种方式把它们变成这个项目的音色下拉。

**方式一：自己挑好，把 ID 交给脚本（推荐）**

去 [fish.audio/discovery](https://fish.audio/discovery/) 按语言和标签筛、试听，挑中的
音色页地址是 `https://fish.audio/m/<32位ID>`。然后：

```bash
node scripts/voices-from-ids.mjs <id1> <id2> <id3>
```

ID 之间空格、逗号、换行都行，**直接粘完整 URL 也认**（脚本会把 ID 抠出来）。名字、
描述、标签、语言、性别全自动填好。想往现有表里追加用 `--append`，ID 多的话用
`--file ids.txt`。

耳朵挑的比任何关键词规则都准 —— 尤其你要的「像开会说话」这种，Fish 的标签体系里
根本没有对应的类别。

**方式二：批量拉 + 自动筛**

```bash
node scripts/fetch-fish-voices.mjs --language en,zh,ja,de,fr,es --per-bucket 3
```

按「会议风」给候选打分：对话感、自然、平和的加分；播音、旁白、宣传、戏剧化的扣分；
动漫、角色音、游戏、唱歌的直接排除。然后按**语种 × 性别**配额挑，保证各语种各性别
都有覆盖。加 `--explain` 能看到每个音色命中了哪些关键词，`--style any` 则关掉筛选、
纯按热度取。

规则在 `scripts/lib/voice-filter.mjs`，觉得不合口味直接改那几个词表。

两种方式都写 `$DATA_DIR/voices.fish.json`，服务按文件 mtime 自动重读，**不用重启**。
没跑过的话会用一份内置兜底表（几个公开示例音色），界面上会提示。

觉得某个音色不合适，直接编辑那个 JSON 删掉一条就行。

### 在 Railway 的容器里跑脚本（本机连不上 fish.audio 时）

有些网络环境访问不到 `api.fish.audio`。这时候在**部署好的容器里**跑 —— 容器的出口走
Railway 的网络，绕开本机的限制。

最省事的是 Railway 控制台自带的网页终端：**Service → Console 标签**。打开就是容器内的
shell，提示符长这样：

```
root@b29eb4f711b4:/app#
```

到了这里就直接跑，环境变量 Railway 已经注入，不需要 `.env`：

```bash
node scripts/check-fish.mjs
```

```bash
node scripts/fetch-fish-voices.mjs --language en,zh --limit 40
```

> **`railway login` / `railway ssh` 是在你自己电脑上用的**，作用是「进到容器里」。
> 如果你已经在网页 Console 里，那一步已经省掉了 —— 在容器里敲 `railway` 只会得到
> `command not found`。
>
> 想用 CLI 的话是在本机：`npm i -g @railway/cli` → `railway login` → `railway link`
> → `railway ssh`，进去之后再跑上面那两条。
>
> 另外**别用 `railway run`**：它只是把 Railway 的环境变量注入到**本机**进程，命令还是
> 在你电脑上跑的，网络照样不通。

在容器里跑 `fetch-fish-voices.mjs` 还有个额外好处：它写的是 `DATA_DIR`（挂载卷），
所以音色表直接落在线上环境，服务按文件 mtime 自动重读，不用重启也不用提交进仓库。

### 对着真实 API 自检

```bash
node --env-file-if-exists=.env scripts/check-fish.mjs
```

会验证：音色库字段齐全性、msgpack 请求、mp3/wav/pcm/opus 各格式、`prosody.speed`
是否真的改变时长、`[方括号标签]` 会不会被念出来、不存在的 `reference_id` 会不会被拒、
单次请求的字数上限。

**2026-09-15 首次对着真实 API 跑通，16 项全过。** 当时确认的几件事：

- 公开音色库有 **1002 个**音色，`description` / `tags` / `languages` / `samples` 都有值
- mp3 / wav / pcm / opus **四种格式都可用**（opus 体积只有 mp3 的四成左右，以后想省磁盘可以换）
- `prosody.speed` 确实改变时长；`[方括号标签]` 确实不会被念出来
- 不存在的 `reference_id` 会返回 **HTTP 400** —— 配错音色会明确失败，不是静默回落到默认音色
- 1200 字的单次请求也没被拒，所以 `MAX_TTS_CHARS` 默认 800 是安全的
- **JSON 请求体也被接受**，msgpack 不是硬要求（我们仍照 SDK 走 msgpack，见 `server/tts.js` 注释）

换模型、换输出格式、或改动 `server/tts.js` 之后值得再跑一遍。

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

**音量为什么不烧进音频** —— 角色音量是播放时 Web Audio 上的一个增益，不是合成参数。
Fish 确实有 `prosody.volume`，但那样音量就会进音频哈希，调一次就得重新合成一遍 ——
而音量本来就是混音决策，应该是即时且免费的。现在它和「抢话时压音量」相乘
（被抢的那句压到 `音量 × duckGain`），静音的角色连解码都省掉，只是安静地占着那段时间。

**为什么没有语气 / 口音 / 情绪那些下拉** —— 早先有过，会拼成一段 `[方括号标签]` 贴在
台词前面。去掉是因为音色现在是从 fish.audio 上按耳朵挑的，每个音色本身就有确定的性格，
再叠一层「专业冷静 + 英式口音」只会和它打架 —— 和当初去掉「性别」下拉是同一个道理。
角色之间的差异靠换音色。留下的语速走 `prosody.speed`（Fish 的真参数，0.5–2.0），
不是提示词。

**为什么用 Web Audio 而不是 `<audio>`** —— `source.start(when)` 是采样级精度的；`<audio>.play()` 的启动抖动有几十毫秒，抢话那 1–3 秒的重叠会被抖没。

**设备之间怎么对时** —— 每台设备连上来之后跑 6 轮 ping，取 RTT 最小的一次算时钟偏移。房主点开始时服务端不立刻开播，而是先发 `play:prepare` 让各设备预加载开头几条，全部报就绪（或 15 秒超时）之后才发带绝对时间戳的 `play:go`。

**长脚本不会把内存吃爆** —— 客户端只提前 20 秒把音频挂到 Web Audio 时间线上，播完就释放解码后的 PCM，再滚动预取后面几条。

**改设定为什么能不重复花钱** —— 音频的身份是 `sha256(模型 + 音色 + 风格 + 语速 + 文本)`，内容寻址、跨房间共享。改一个角色的口音只会重跑它自己的句子；改回来则一次请求都不发，因为旧文件还在。合成本身是显式触发的，所以调设定的过程完全免费。

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
