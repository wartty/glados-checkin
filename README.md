# GLaDOS 自动签到

面向 **青龙面板** 的 GLaDOS 每日自动签到脚本。纯 Node.js 实现，**零第三方依赖** —— 青龙面板不需要安装任何依赖包，Node 18+ 直接跑。

- ✅ 多账号支持
- ✅ 自动切换域名（`glados.cloud` / `glados.rocks` / `glados.network`）
- ✅ 适配 2026 年新版 API（`token` 值 + 设备校验）
- ✅ 积分自动兑换会员天数（可选）
- ✅ PushPlus / Telegram 推送
- ✅ 单账号失败不影响其他账号

---

## 一、为什么需要这个脚本

GLaDOS 在 2026 年更新了 API，**网上绝大多数老脚本已经失效**，典型症状是签到返回：

```
please checkin via https://glados.cloud
```

原因是签到请求里的 `token` 字段值必须与站点域名一致。老脚本写的是 `glados.one`，现在必须写 `glados.cloud`。

更隐蔽的一个坑：**GLaDOS 从 2026-09 起会校验设备**。服务端从请求的 `User-Agent` 里解析出平台名，和你当初登录时的平台比对。**对不上就返回 `code=4`（`device-mismatch`）**，但此时 `status` 和 `points` 接口都是正常的 —— 很容易被误判成 Cookie 过期，排查到崩溃。

本脚本对这两点都做了处理，并把 `device-mismatch` 单独识别出来给出明确提示。

---

## 二、获取 Cookie 与 User-Agent

### 1. 获取 Cookie

1. 浏览器打开 <https://glados.cloud> 并登录
2. 进入 **签到页面**（Console → Checkin）
3. 按 `F12` 打开开发者工具，切到 **Network** 标签
4. 点击页面上的**签到**按钮
5. 在请求列表里找到名为 **`checkin`** 的请求，点开
6. 在 **Request Headers** 里找到 **`Cookie`** 字段，**整段复制**

**⚠️ 必须包含 `gld:sess` 与 `gld:sess.sig`**

2026-09 起站点把会话拆成了两个新字段，**两个都要有，缺一个就签不上**：

| 字段 | 说明 |
| --- | --- |
| `gld:sess` | 会话 ID |
| `gld:sess.sig` | 会话签名（漏掉它是最常见的复制错误） |

旧的 `koa:sess` / `koa:sess.sig` **即使没过期，调新版 API 也会返回 `没有权限`（`code=-2`）**。
好在完整 Cookie 里新旧字段是**同时下发**的，所以**整段复制即可，不要手工挑字段**。

复制后请确认值里同时出现 `gld:sess=` 和 `gld:sess.sig=`。形如：

```
gld:sess=eyJ1c2VySWQiOjEyMzQ1Njc4OTB9; gld:sess.sig=abcdef123456; koa:sess=...; koa:sess.sig=...
```

> **格式要点**：分号后**必须有一个空格**，值两边**不要加引号**。
> 多余字段（`theme`、`_ga` 之类）不影响使用。脚本也做了较强容错（支持 JSON、裸 JWT、`Cookie:` 前缀等），但保持标准格式最稳妥。

### 2. 获取 User-Agent（重要）

GLaDOS 从 2026-09 起会校验**登录设备**：服务端从 `User-Agent` 解析出平台，与登录时的平台比对，不一致就返回 `code=4`（`Automated check-in detected`）。

**关键：只比对「平台」，不比对完整字符串。** 平台只有这几种取值：

```
Windows / macOS / Linux / Android / iOS / Bot / Other
```

所以 Chrome 版本号、小版本差异都**不影响** —— 只有平台必须对上。

**怎么拿**（任选一种）：

- **最简单**：用你**平时登录 GLaDOS 的那个浏览器**打开 `glados.cloud`，按 `F12` → **Console**，输入 `navigator.userAgent` 回车，复制输出的完整字符串
- 地址栏输入 `chrome://version`，复制「用户代理」那一整行
- 在 `checkin` 请求的 Request Headers 里复制 `User-Agent`

> 想确认自己登录用的是哪个平台：登录状态下访问 `https://glados.cloud/api/user/sessions`，看 `device` 字段。

**要不要配？**

| 你的登录环境 | 是否需要配置 |
| --- | --- |
| Windows 电脑的 Chrome / Edge | **不用配**，脚本默认值就是 Windows Chrome |
| macOS / Linux / 手机 / iPad | **必须配**，否则会被判为自动签到 |

**怎么填**：

| 场景 | 写法 |
| --- | --- |
| 青龙面板 | 环境变量 → 新建 → 名称 `GLADOS_USER_AGENT`，值**直接粘贴**（输入框里不用加引号） |
| shell 临时运行 | **必须加引号**，否则会被 shell 截断 |

```bash
# shell 临时运行
GLADOS_USER_AGENT='Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...' node src/index.js
```

**配错了怎么看出来**：脚本失败时会打印服务端给的对比 ——

```
设备校验失败 (device-mismatch)：登录设备 Windows，当前请求 macOS
```

`loginDevice` 是你登录时的平台（**照它改**），`currentDevice` 是这次请求被识别成的平台；**`currentDevice` 为空**说明 UA 根本没带上。

> ⚠️ 设备校验不通过时，`status` / `points` 接口**是正常的**，所以很容易误判成 Cookie 过期。

---

## 三、青龙面板部署

### 1. 添加环境变量

青龙面板 → **环境变量** → **新建变量**：

| 变量名 | 值 | 必填 |
| --- | --- | --- |
| `GLADOS_COOKIE` | 上一步复制的完整 Cookie（须含 `gld:sess`） | ✅ |
| `GLADOS_USER_AGENT` | 登录浏览器的 User-Agent（见第二节 2） | 非 Windows 登录时必填 |

多账号：**多次添加** `GLADOS_COOKIE` 变量，或用 `&` / 换行在单个变量里分隔。

> **值直接粘贴，不要带引号** —— 青龙的输入框不会像 shell 那样剥引号，带上引号会变成值的一部分。
> **变量名需符合青龙规范**：只能含字母、数字、下划线，且以字母或下划线开头 —— 不符合的名字会被青龙静默丢弃。

### 2. 上传脚本

把本项目放到青龙的脚本目录下（例如 `/ql/scripts/glados-checkin/`），或通过 Git 仓库拉取。

### 3. 创建定时任务

青龙面板 → **定时任务** → **新建任务**：

| 字段 | 值 |
| --- | --- |
| 名称 | GLaDOS 签到 |
| 命令 | `task glados-checkin/src/index.js` |
| 定时规则 | `0 30 9 * * *` |

> 定时规则是 **6 位 cron**（秒 分 时 日 月 周），`0 30 9 * * *` 表示每天 09:30:00。
> 建议**避开整点**，能减少被限流的概率。
>
> `task` 是青龙执行脚本的标准写法；路径相对 `/ql/scripts`，子目录要写全。

---

## 四、本地运行

```bash
GLADOS_COOKIE="gld:sess=xxx; gld:sess.sig=yyy" node src/index.js
```

> shell 里赋值注意**加引号** —— Cookie 含分号空格、UA 含空格括号，不加引号会被 shell 截断。

---

## 五、配置项

全部通过青龙面板的环境变量配置。除 `GLADOS_COOKIE` 外均可选。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GLADOS_COOKIE` | — | **必填**。账号 Cookie，多账号用 `&` 或换行分隔。也认复数名 `GLADOS_COOKIES` |
| `GLADOS_USER_AGENT` | Windows Chrome UA | 与登录时一致的浏览器 UA。**设备校验不通过时改这里**。也认 `GLADOS_UA` |
| `GLADOS_DOMAINS` | `glados.cloud,glados.rocks,glados.network` | 候选域名，逗号分隔，按顺序尝试 |
| `GLADOS_CHECKIN_TOKEN` | `glados.cloud` | 签到 token，仅官方再次改 API 时才需要动 |
| `EXCHANGE_PLAN` | `off` | 自动兑换档位，见下 |
| `PUSH_LEVEL` | `fail_only` | `fail_only` 仅失败时推送 / `all` 每次都推送 |
| `PUSHPLUS_TOKEN` | — | PushPlus 微信推送 Token |
| `TELEGRAM_BOT_TOKEN` | — | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | — | Telegram 接收者 Chat ID |
| `GLADOS_TIMEOUT_MS` | `15000` | 单次请求超时（毫秒） |
| `GLADOS_RETRIES` | `3` | 签到失败重试次数 |
| `GLADOS_RETRY_DELAY_MS` | `20000` | 重试间隔（毫秒） |
| `NOTIFY_TITLE` | `GLaDOS 签到` | 推送标题前缀 |

### 积分自动兑换

签到攒够积分可自动换成会员天数，实现无感续期：

| `EXCHANGE_PLAN` | 效果 |
| --- | --- |
| `off`（默认） | 关闭自动兑换 |
| `plan100` | 100 分 → 10 天 |
| `plan200` | 200 分 → 30 天 |
| `plan500` | 500 分 → 100 天 |

积分不足时会静默跳过（只在日志里记一行），不会打扰你。

> ⚠️ 兑换是不可逆操作，会消耗积分。建议先保持 `off` 观察几天，确认签到稳定后再开启。

---

## 六、退出码

方便青龙/其他调度器判断结果：

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部账号成功（含「今日已签到」） |
| `1` | 存在失败账号 / 未配置 Cookie / 网络异常 |

---

## 七、常见问题

**Q：青龙里提示「读不到 Cookie / 未配置 GLADOS_COOKIE」，但我确实配了？**

脚本启动时会打印环境诊断（只列变量名与长度、**不打印值**，可以放心贴出来求助），照下面几条对照检查：

- 该变量在青龙「环境变量」里是否处于**启用**状态；
- 变量名是否符合青龙规范 —— 只能含字母、数字、下划线，且以字母或下划线开头。**不符合的会被青龙静默丢弃**，但面板里照常显示；
- 变量名有没有多余空格、大小写或单复数差异 —— 诊断会把名字用引号包起来，尾随空格因此可见；
- 值是否真的保存进去了 —— 诊断会给出长度，**长度为 0** 就是没存上；
- 变量是否加在了当前这个青龙实例上。

另外两个高频坑：

- **连引号一起粘进去了** —— 从文档里复制时把 `"` 也带上了。脚本会自动剥掉成对引号，但建议直接粘裸值。
- **只复制了 `koa:*` 旧字段** —— 脚本会提示「没有 gld:sess」，见下面 `code=-2` 那条。

**Q：日志显示 `please checkin via https://glados.cloud` ？**
签到 token 失效了。GLaDOS 又改了 API 值，把 `GLADOS_CHECKIN_TOKEN` 设成日志里提示的那个域名。

**Q：日志显示 `设备校验失败 (device-mismatch)`？**
这是 2026-09 新增的设备校验。脚本会同时打印服务端返回的 `loginDevice`（登录平台）与 `currentDevice`（本次请求被识别成的平台）。
把 `GLADOS_USER_AGENT` 改成 `loginDevice` 对应的平台即可 —— **只比对平台，版本号无所谓**。
注意此时 `status` / `points` 接口是正常的，别误以为是 Cookie 问题。详见第二节 2。

**Q：`Cookie 失效或无权限 (code=-2)`？**
两种可能：
1. **复制漏了字段** —— 确认 Cookie 里同时有 `gld:sess=` 和 `gld:sess.sig=`。2026-09 起新增的这两个字段缺一不可，只有旧的 `koa:*` 会一直报这个错；
2. **Cookie 过期** —— 重新走第二步获取。GLaDOS 的 Cookie 大约 30 天失效。

**Q：`今日已签到` 算失败吗？**
不算。这表示今天已经签到过了，脚本会返回退出码 `0`。

**Q：需要装依赖吗？**
不需要。脚本只用 Node 内置的 `fetch`，青龙面板的「依赖管理」不用管。只需要 Node 18 以上版本。

**Q：想跑多个账号？**
`GLADOS_COOKIE` 里用 `&` 或换行分隔多个 Cookie 即可，脚本会依次处理。
换行分隔更安全 —— Cookie 值本身可能含 `&`。

---

## 八、项目结构

```
glados-checkin/
├── src/
│   ├── index.js      # 入口：编排签到流程、重试、汇总
│   ├── config.js     # 环境变量解析与 Cookie 归一化
│   ├── glados.js     # API 客户端（域名回退、响应分类）
│   └── notify.js     # 推送（PushPlus / Telegram）
├── .gitignore
├── LICENSE
└── package.json
```

---

## 九、免责声明

本脚本仅用于自动化**你自己账号**的每日签到，避免手动操作。
请遵守 GLaDOS 的服务条款。因使用本脚本产生的任何后果由使用者自行承担。

## License

MIT