# ReadRoom

上传一份 transcript，把里面的角色分给屋子里的每台电脑，让它们用各自的音色、语气、口音把这场对话读出来。

TTS 用 Gemini 3.1 Flash TTS（经 OpenRouter）。

- **创建 / 加入 room** —— 6 位房间号，其他电脑输号进来
- **角色设定** —— 每个 speaker 有音色（Gemini 30 种预置）+ 年龄感 / 语气 / 口音 / 语速 / 情绪 / 说话习惯，默认随机；风格标签也可以直接手写。性别由音色本身决定，不单独设
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
OPENROUTER_API_KEY=sk-or-v1-...
```

然后：

```bash
npm run dev
```

打开 http://localhost:3000 。启动日志里会列出局域网地址，同一个 Wi-Fi 下的其他电脑用那个地址就能加入。

### 全部环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | 必填 | 只在服务端使用，永远不会下发到浏览器 |
| `TTS_MODEL` | `google/gemini-3.1-flash-tts-preview` | |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | SQLite 和生成的 mp3 都在这里。部署时指向挂载磁盘 |
| `TTS_CONCURRENCY` | `4` | 同时并发的 TTS 请求数 |
| `OPENROUTER_BASE_URL` | — | 指向别的兼容端点，本地测试时可以指向下面的 mock |

### 不花钱地测试

`scripts/mock-tts.js` 是个假 TTS，返回合法的静音 mp3，时长按文本长度估算，所以排期、抢话、重叠、缓存这些逻辑都能真实验证：

```bash
node scripts/mock-tts.js
```

另开一个终端：

```bash
OPENROUTER_API_KEY=mock-key-for-local-testing-only OPENROUTER_BASE_URL=http://127.0.0.1:4010/v1 npm run dev
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

**为什么用 Web Audio 而不是 `<audio>`** —— `source.start(when)` 是采样级精度的；`<audio>.play()` 的启动抖动有几十毫秒，抢话那 1–3 秒的重叠会被抖没。

**设备之间怎么对时** —— 每台设备连上来之后跑 6 轮 ping，取 RTT 最小的一次算时钟偏移。房主点开始时服务端不立刻开播，而是先发 `play:prepare` 让各设备预加载开头几条，全部报就绪（或 15 秒超时）之后才发带绝对时间戳的 `play:go`。

**长脚本不会把内存吃爆** —— 客户端只提前 20 秒把音频挂到 Web Audio 时间线上，播完就释放解码后的 PCM，再滚动预取后面几条。

**改设定为什么能不重复花钱** —— 音频的身份是 `sha256(模型 + 音色 + 风格标签 + 文本)`，内容寻址、跨房间共享。改一个角色的口音只会重跑它自己的句子；改回来则一次请求都不发，因为旧文件还在。合成本身是显式触发的，所以调设定的过程完全免费。

**为什么没有“性别”下拉** —— 性别已经由 `voice` 参数决定了（音色下拉里就标着男声 / 女声）。再在风格标签里写一句 "a male speaker" 只会和音色本身打架，让模型在两个信号之间摇摆。

---

## 部署

因为要跑 WebSocket 长连接（Socket.IO）和持久磁盘，**不能用 Vercel**。

### Railway（推荐）

仓库里有 `railway.json`，构建走 Nixpacks（`npm ci` → `npm run build` → `npm start`）。

1. Railway 里 **New Project → Deploy from GitHub repo**，选这个仓库
2. **Variables** 里加两个：
   - `OPENROUTER_API_KEY` = 你的 key
   - `DATA_DIR` = `/data`
3. **必须加一块 Volume**：服务的 Settings → Volumes → Add Volume，Mount path 填 `/data`
4. Settings → Networking → **Generate Domain**，拿到公网地址

`PORT` 由 Railway 自动注入，代码直接读 `process.env.PORT`，不用管。

Node 版本靠 `.nvmrc`（`24`）和 `package.json` 的 `engines` 决定。**别降到 22.13 以下** ——
`node:sqlite` 在那之前还需要 `--experimental-sqlite` 标志，服务会起不来。

> 仓库里也有 `Dockerfile`，Railway 默认会优先用它。`railway.json` 里显式指定了
> `NIXPACKS` 来绕开这一点 —— Dockerfile 是给 Fly / VPS 准备的，我没有 Docker 环境验证过。

### Render

`render.yaml` 直接可用 —— 建一个 Blueprint 服务，在控制台填 `OPENROUTER_API_KEY`。
磁盘挂在 `/var/data`，`DATA_DIR` 已经指过去了。注意免费层没有持久磁盘。

### Fly.io / 自己的 VPS

用 `Dockerfile`，把一块卷挂到 `/data`：

```bash
fly launch --no-deploy
fly volumes create readroom_data --size 5
fly secrets set OPENROUTER_API_KEY=sk-or-v1-...
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

**不管用哪家，一定要挂持久磁盘。** 不挂的话每次重部署，整份 transcript 都要重新 TTS 一遍
—— SQLite 和 mp3 都在 `DATA_DIR` 下。

---

## 代码结构

```
server.js              自定义 Node server：Next + Express + Socket.IO 一个进程
server/
  db.js                node:sqlite 建表；音频文件路径
  parse.js             transcript 解析（纯文本 / 时间戳 / SRT / JSON）
  voices.js            音色目录、各维度选项、风格标签拼装、随机配置
  tts.js               OpenRouter 调用、内容寻址缓存、时长探测、限流重试
  generate.js          房间级的批量合成任务（限并发、推进度、跑完再扫一遍）
  schedule.js          把台词排成带绝对偏移的时间线（有序 / 抢话 / 压音量）
  rooms.js             房间、角色、设备、分配、设置的读写
  api.js               HTTP 接口（建房、上传、音频文件）
  realtime.js          Socket.IO：实时状态、房主操作、开播握手
lib/                   前端：socket hook、Web Audio 引擎、时钟同步、YouTube 环境音
components/            上传器、角色卡、设备面板、基调设置、台词、开场面板
scripts/mock-tts.js    本地假 TTS
```
