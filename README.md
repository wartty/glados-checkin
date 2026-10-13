# GLaDOS / Railgun 自动签到

面向 **青龙面板** 的自动签到脚本，同时支持 **GLaDOS** 与 **Railgun** 两个站点。两者后端是同一套 API，账号迁移到哪个站点就签到哪个。纯 Node.js 实现，**零第三方依赖** —— 青龙面板不需要安装任何依赖包，Node 18+ 直接跑。

- ✅ 双站点支持：`glados.cloud` 与 `railgun.info`，各用自己的 Cookie 变量
- ✅ 一份脚本：配了哪个站点的 Cookie 就签到哪个；只配一个，行为等同于单站点脚本
- ✅ 多账号支持
- ✅ 自动切换域名（`glados.cloud` / `glados.rocks` / `glados.network`）
- ✅ 签到 token 按实际域名自动推导
- ✅ 适配设备校验（`code=4` device-mismatch）
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

### 关于 Railgun

GLaDOS 有部分账号会被迁移到新站点 **Railgun**（<https://railgun.info>）。两个站点共用一套后端：

| | GLaDOS | Railgun |
| --- | --- | --- |
| 域名 | `glados.cloud` / `glados.rocks` / `glados.network` | `railgun.info` |
| Cookie 变量 | `GLADOS_COOKIE` | `RAILGUN_COOKIE` |
| 会话字段 | `gld:sess` + `gld:sess.sig` | `koa:sess` + `koa:sess.sig` |

API 路径（`/api/user/checkin`、`/api/user/status`、`/api/user/points`、`/api/user/exchange`）与返回码完全一致，所以本脚本共用一份实现，只是按站点换域名和 Cookie。

> **签到 token 恒等于当前域名**。这是站点前端自己的行为 —— `axios.post('/user/checkin', {token: location.hostname})` —— 所以脚本按实际请求的域名自动推导，**不需要配置**。

---

## 二、获取 Cookie 与 User-Agent

### 1. 获取 Cookie

1. 浏览器打开站点并登录 —— GLaDOS 是 <https://glados.cloud>，Railgun 是 <https://railgun.info>
2. 进入 **签到页面**（Console → Checkin）
3. 按 `F12` 打开开发者工具，切到 **Network** 标签
4. **刷新一下页面**（`F5`）—— 不需要点签到按钮
5. 在请求列表里找到 **`status`** 请求（即 `/api/user/status`），点开
6. 在 **Request Headers** 里找到 **`Cookie`** 字段，**整段复制**

> 用 `status` 请求而不是 `checkin`：刷新页面就能拿到，**不会误触发掉当天的签到**。

**必须包含会话字段，两个站点的字段名不同：**

| 站点 | 会话字段 | 说明 |
| --- | --- | --- |
| GLaDOS | `gld:sess` + `gld:sess.sig` | 2026-09 起启用。旧的 `koa:*` 即使没过期，调新版 API 也会返回 `没有权限`（`code=-2`） |
| Railgun | `koa:sess` + `koa:sess.sig` | 仍是旧的命名 |

缺一个就签不上。好在完整 Cookie 里新老字段通常是**同时下发**的，所以**整段复制即可，不要手工挑字段**。

复制后确认值里同时出现该站点的两个字段，形如：

```
gld:sess=eyJ1c2VySWQiOjEyMzQ1Njc4OTB9; gld:sess.sig=abcdef123456; koa:sess=...; koa:sess.sig=...
```

> **格式要点**：分号后**必须有一个空格**，值两边**不要加引号**。
> 多余字段（`theme`、`_ga` 之类）不影响使用。脚本也做了较强容错（支持 JSON、裸 JWT、`Cookie:` 前缀等），但保持标准格式最稳妥。

### 2. 获取 User-Agent（重要）

站点从 2026-09 起会校验**登录设备**：服务端从 `User-Agent` 解析出平台，与登录时的平台比对，不一致就返回 `code=4`（`Automated check-in detected`）。两个站点行为一致。

**关键：只比对「平台」，不比对完整字符串。** 平台只有这几种取值：

```
Windows / macOS / Linux / Android / iOS / Bot / Other
```

所以 Chrome 版本号、小版本差异都**不影响** —— 只有平台必须对上。

**怎么拿**（任选一种）：

- **最简单**：用你**平时登录该站点的那个浏览器**打开它，按 `F12` → **Console**，输入 `navigator.userAgent` 回车，复制输出的完整字符串
- 地址栏输入 `chrome://version`，复制「用户代理」那一整行
- 在 `status` 请求的 Request Headers 里复制 `User-Agent`

> 想确认自己登录用的是哪个平台：登录状态下访问 `<站点>/api/user/sessions`，看 `device` 字段。

**要不要配？**

| 站点 | 是否需要配置 |
| --- | --- |
| GLaDOS | **非 Windows 登录必须配**（`GLADOS_USER_AGENT`），否则会被判为自动签到 |
| Railgun | **不需要** —— 它的设备标识是 `RAILGUN_AUTHORIZATION` 指纹，与 UA 无关 |

| 你的登录环境（GLaDOS） | 是否需要配置 |
| --- | --- |
| Windows 电脑的 Chrome / Edge | **不用配**，脚本默认值就是 Windows Chrome |
| macOS / Linux / 手机 / iPad | **必须配**，否则会被判为自动签到 |

**怎么填** —— 变量名按站点选，GLaDOS 用 `GLADOS_USER_AGENT`，Railgun 用 `RAILGUN_USER_AGENT`（后者通常不需要）：

| 场景 | 写法 |
| --- | --- |
| 青龙面板 | 环境变量 → 新建 → 名称 `GLADOS_USER_AGENT`（或 `RAILGUN_USER_AGENT`），值**直接粘贴**（输入框里不用加引号） |
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

青龙面板 → **环境变量** → **新建变量**。**两个站点各有自己的 Cookie 变量**，配了哪个就签到哪个：

| 变量名 | 值 | 必填 |
| --- | --- | --- |
| `GLADOS_COOKIE` | glados.cloud 的完整 Cookie（须含 `gld:sess`） | 有 GLaDOS 账号时 |
| `RAILGUN_COOKIE` | railgun.info 的完整 Cookie（须含 `koa:sess`） | 有 Railgun 账号时 |
| `GLADOS_USER_AGENT` | 登录 glados 浏览器的 User-Agent（见第二节 2） | 非 Windows 登录时必填 |
| `RAILGUN_USER_AGENT` | 登录 railgun 浏览器的 User-Agent | 不需要（Railgun 用指纹识别设备） |

两个都配就一次跑完两个站点；只配一个就是单站点。

多账号：**多次添加**同一个变量，或用 `&` / 换行在单个变量里分隔。

> **值直接粘贴，不要带引号** —— 青龙的输入框不会像 shell 那样剥引号，带上引号会变成值的一部分。
> **变量名需符合青龙规范**：只能含字母、数字、下划线，且以字母或下划线开头 —— 不符合的名字会被青龙静默丢弃。

### 2. 上传脚本

把本项目放到青龙的脚本目录下（例如 `/ql/scripts/glados-checkin/`），或通过 Git 仓库拉取。

### 3. 创建定时任务

青龙面板 → **定时任务** → **新建任务**：

| 字段 | 值 |
| --- | --- |
| 名称 | GLaDOS / Railgun 签到 |
| 命令 | `task glados-checkin/src/index.js` |
| 定时规则 | `0 30 9 * * *` |

> 定时规则是 **6 位 cron**（秒 分 时 日 月 周），`0 30 9 * * *` 表示每天 09:30:00。
> 建议**避开整点**，能减少被限流的概率。
>
> `task` 是青龙执行脚本的标准写法；路径相对 `/ql/scripts`，子目录要写全。

> 💡 后续如果账号**全部**迁移到 Railgun，不需要改代码：脚本会自动只签到配了 Cookie 的站点。真要清理时删掉 `GLADOS_*` 变量和 `sites.js` 里的 GLaDOS 档案即可。

---

## 四、本地运行与验证

```bash
# 单站点
GLADOS_COOKIE="gld:sess=xxx; gld:sess.sig=yyy" node src/index.js

# 两个站点一起
GLADOS_COOKIE="gld:sess=xxx; gld:sess.sig=yyy" \
RAILGUN_COOKIE="koa:sess=aaa; koa:sess.sig=bbb" node src/index.js
```

> shell 里赋值注意**加引号** —— Cookie 含分号空格、UA 含空格括号，不加引号会被 shell 截断。

### 先做只读体检（推荐）

第一次配置建议先加 `--dry-run`（或 `--check`）。它**只调 `status` / `points` 两个只读接口，不签到、不兑换、不推送** —— 所以不会消耗当天的签到。

```bash
GLADOS_COOKIE="..." RAILGUN_COOKIE="..." node src/index.js --dry-run
```

输出示例：

```
🔎 只读体检模式（不会签到，不消耗当天签到）
📋 待体检站点: GLaDOS + Railgun
🌐 GLaDOS  | 账号数 1 | 域名 https://glados.cloud, ...
🌐 Railgun | 账号数 1 | 域名 https://railgun.info
🔎 [GLaDOS] 账号 1 只读体检（不签到）
✅ [GLaDOS] 账号 1 | 积分: 412 | 天数: 29 | Cookie 有效，体检通过（本次未签到）
📊 体检完成: Cookie 可用 1/1
```

**这一步能确认什么：**

| 检查项 | 说明 |
| --- | --- |
| 变量读到了 | 没读到会直接列环境诊断 |
| Cookie 在该域名有效 | 通过则打印出**邮箱、积分、剩余天数** |
| **账号属于哪个站点** | 迁移场景的关键 —— 报「账号不在 X」就说明该换另一个站点的变量 |
| 请求头被接受 | Origin / Referer / User-Agent 都对上了才有响应 |

**体检通过后**，去掉 `--dry-run` 跑正式签到即可。签到本身是幂等的 —— 重复跑只会提示「今日已完成签到」，没有副作用。

> 唯一体检**验不出来**的是签到 token，因为只有 `checkin` 接口才用它。万一 token 值有问题，日志会直接给出服务端期望的域名，用 `<站点>_CHECKIN_TOKEN` 覆盖即可。

### 不确定账号在哪个站点？

用归属探测 —— 它把已配置的凭证**逐个拿到每个站点的每个域名**上试一次（只读）：

```bash
GLADOS_COOKIE="..." RAILGUN_COOKIE="..." node src/index.js --probe
```

```
🍪 凭证 #1（来自 RAILGUN_COOKIE）
   字段: koa:sess(268)  koa:sess.sig(43)
   ❌ GLaDOS @ glados.cloud    -> code=-2  没有权限
   ✅ Railgun @ railgun.info   -> code=0  邮箱 me@example.com  积分 412  剩余 29 天
```

出现 ✅ 的那一行，就是该账号当前所在的站点。凭证是按站点签发的，同一份在 A 站通过、在 B 站被拒都属正常。

---

## 五、通过青龙验证

前面的 `--dry-run` 在青龙里同样可用 —— 临时把定时任务的命令改成：

```
task glados-checkin/src/index.js --dry-run
```

跑一次看日志，确认无误后**再改回**不带参数的命令。这样能在正式启用前先验证青龙的环境变量确实传进来了。

---

## 六、配置项

全部通过青龙面板的环境变量配置。**至少要配一个站点的 Cookie**，其余均可选。

### 站点相关

两个站点对称，下面的 `XXX` 对 GLaDOS 是 `GLADOS`、对 Railgun 是 `RAILGUN`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `XXX_COOKIE` | — | 该站点的账号 Cookie，多账号用 `&` 或换行分隔。也认复数名 `XXX_COOKIES` |
| `XXX_USER_AGENT` | Windows Chrome UA | 该浏览器 UA。GLaDOS 用它做设备校验；Railgun 不需要。也认 `XXX_UA` |
| `XXX_DOMAINS` | GLaDOS: `glados.cloud,glados.rocks,glados.network`<br>Railgun: `railgun.info` | 候选域名，逗号分隔，按顺序尝试 |
| `XXX_CHECKIN_TOKEN` | 按域名自动推导 | 正常不用配，仅官方再次改 API 时才需要覆盖 |
| `XXX_AUTHORIZATION` | — | 设备指纹，放在 `Authorization` 头里（**不是令牌**）。Railgun 建议配，见下 |
| `XXX_EXCHANGE_PLAN` | 回落 `EXCHANGE_PLAN` | 该站点的自动兑换档位，见下 |

### Railgun 的设备指纹（`RAILGUN_AUTHORIZATION`）

railgun.info 的前端会在每个 `/api/user/...` 请求上带一个 `Authorization` 头，但它**不是登录令牌**，而是浏览器指纹：

```js
Ta = getCanvasFingerprint() + "-" + screen.height + "-" + screen.width
```

形如 `<画布哈希>-1080-1920`。服务端很可能把会话与这个指纹绑定 —— **只带 Cookie 不带指纹时，请求看起来像「另一台设备」**，可能因此被判为无权限（`code=-2`）。

好消息：它**长期有效**（同一浏览器基本不变），不像会话那样会过期。从浏览器任意一个 `/api/user/...` 请求的 Request Headers 里复制即可，**不需要点签到按钮**：

```bash
RAILGUN_AUTHORIZATION=<画布哈希>-1080-1920
```

### 全局

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EXCHANGE_PLAN` | `off` | 两个站点共用的自动兑换档位，见下 |
| `PUSH_LEVEL` | `fail_only` | `fail_only` 仅失败时推送 / `all` 每次都推送 |
| `PUSHPLUS_TOKEN` | — | PushPlus 微信推送 Token |
| `TELEGRAM_BOT_TOKEN` | — | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | — | Telegram 接收者 Chat ID |
| `CHECKIN_TIMEOUT_MS` | `15000` | 单次请求超时（毫秒）。也认旧名 `GLADOS_TIMEOUT_MS` |
| `CHECKIN_RETRIES` | `3` | 签到失败重试次数。也认旧名 `GLADOS_RETRIES` |
| `CHECKIN_RETRY_DELAY_MS` | `20000` | 重试间隔（毫秒）。也认旧名 `GLADOS_RETRY_DELAY_MS` |
| `NOTIFY_TITLE` | 各站点名拼接 | 推送标题前缀 |

> Cookie 失效（`code=-2`）和设备校验失败（`code=4`）都是**确定性失败，不会重试** —— 重试次数只对网络抖动等瞬时故障生效。

### 积分自动兑换

签到攒够积分可自动换成会员天数，实现无感续期：

| 档位 | 效果 |
| --- | --- |
| `off`（默认） | 关闭自动兑换 |
| `plan100` | 100 分 → 10 天 |
| `plan200` | 200 分 → 30 天 |
| `plan500` | 500 分 → 100 天 |

积分不足时会静默跳过（只在日志里记一行），不会打扰你。

> ⚠️ 兑换是不可逆操作，会消耗积分。建议先保持 `off` 观察几天，确认签到稳定后再开启。

---

## 七、退出码

方便青龙/其他调度器判断结果：

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部账号成功（含「今日已完成签到」） |
| `1` | 存在失败账号 / 未配置 Cookie / 网络异常 |

---

## 八、常见问题

**Q：青龙里提示「读不到 Cookie / 未配置 GLADOS_COOKIE」，但我确实配了？**

脚本启动时会打印环境诊断（只列变量名与长度、**不打印值**，可以放心贴出来求助），照下面几条对照检查：

- 该变量在青龙「环境变量」里是否处于**启用**状态；
- 变量名是否符合青龙规范 —— 只能含字母、数字、下划线，且以字母或下划线开头。**不符合的会被青龙静默丢弃**，但面板里照常显示；
- 变量名有没有多余空格、大小写或单复数差异 —— 诊断会把名字用引号包起来，尾随空格因此可见；
- 值是否真的保存进去了 —— 诊断会给出长度，**长度为 0** 就是没存上；
- 变量是否加在了当前这个青龙实例上。

另外两个高频坑：

- **连引号一起粘进去了** —— 从文档里复制时把 `"` 也带上了。脚本会自动剥掉成对引号，但建议直接粘裸值。
- **会话字段不对** —— 脚本会提示缺了哪个字段：GLaDOS 要 `gld:sess`，Railgun 要 `koa:sess`。

**Q：日志显示 `please checkin via https://glados.cloud` ？**
签到 token 失效了，站点又改了 API 值。把 `GLADOS_CHECKIN_TOKEN` 设成日志里提示的那个域名即可。

**Q：日志显示 `设备校验失败 (device-mismatch)`？**
这是 2026-09 新增的设备校验。脚本会同时打印服务端返回的 `loginDevice`（登录平台）与 `currentDevice`（本次请求被识别成的平台）。
把对应站点的 UA 变量改成 `loginDevice` 对应的平台即可 —— **只比对平台，版本号无所谓**：
GLaDOS 改 `GLADOS_USER_AGENT`，Railgun 改 `RAILGUN_USER_AGENT`。
注意此时 `status` / `points` 接口是正常的，别误以为是 Cookie 问题。详见第二节 2。

**Q：`Cookie 失效或无权限 (code=-2)`？**
两种可能：
1. **复制漏了字段** —— GLaDOS 需要 `gld:sess=` 与 `gld:sess.sig=`，Railgun 需要 `koa:sess=` 与 `koa:sess.sig=`，缺一个都会一直报这个错。回到第二节，从 `status` 请求里**整段复制**；
2. **Cookie 过期** —— 重新走第二步获取。Cookie 大约 30 天失效。

> 这个错误是确定性的，脚本**不会重试**，直接判失败。

**Q：不确定账号到底在 GLaDOS 还是 Railgun？**
用只读体检：把同一个 Cookie 分别填到 `GLADOS_COOKIE` 和 `RAILGUN_COOKIE`，各跑一次 `--dry-run`（见第四节）。
能读出邮箱、积分、天数的那一边，就是账号所在的站点 —— 过程不消耗签到。

**Q：账号在 Railgun，但我只配了 glados 的 Cookie？**
脚本只签到**配了 Cookie 的站点**，不会拿 glados 的 Cookie 去试 railgun。账号在哪个站点，就配哪个站点的 Cookie 变量。

**Q：`今日已完成签到` 是什么意思？算失败吗？**
不算 —— 这正是**成功**的一种，退出码 `0`。它表示：本次没签到，但账号今天**早就签过了**（比如你手动签过，或当天第二次运行）。

脚本会区分「刚签到成功」和「今天已经签过」，因为两者意义不同：

```
ℹ️ 账号今日已完成签到（服务端返回「Checkin Repeats! Please Try Tomorrow」），本次不重复签到
✅ [GLaDOS] 账号 1 | 积分: 412 | 天数: 29 | 今日已完成签到（服务端返回「...」）
```

判定依据也会写进结果，两个站点各自取最可靠的信号：

| 站点 | 怎么判定今天已经签过 |
| --- | --- |
| GLaDOS | 服务端文案（`Checkin Repeats!`） |
| Railgun | 转去查 `/user/points`，看 `checkedIn` 或历史里有没有今天 |

> **为什么 Railgun 要额外查一次？** 它的「已签到」不用成功码表达。站点前端对**任何**非 0 返回都会转去查 `/user/points` 确认 —— 只看签到返回码，每天第二次运行就会误报失败并推送告警。

**Q：日志显示 `签到 token 已失效`？**
服务端回了 `please checkin via <域名>`，说明签到 token 与当前域名不符。这是**确定性失败，不会重试**。
正常情况 token 由域名自动推导，不会出错；真遇到就用 `<站点>_CHECKIN_TOKEN` 覆盖成提示里的那个域名。

> 这个判定排在「今日已完成签到」**之前** —— 否则 token 配错时，只要当天恰好签过就会被误判为一切正常，问题要拖到第二天才暴露。

**Q：日志显示 `请求过快被限流`？**
Railgun 回了 `code=2`（`Too fast, please wait`）。这是可恢复的，脚本会按 `CHECKIN_RETRY_DELAY_MS` 重试；仍失败就稍后再跑一次。

**Q：日志显示 `原始响应: {...}`？**
说明服务端返回了一个脚本还没识别的码。日志里已经把原始响应带上了，**直接把那一行发出来**即可定位，不需要再开 `--debug`。

**Q：需要装依赖吗？**
不需要。脚本只用 Node 内置的 `fetch`，青龙面板的「依赖管理」不用管。只需要 Node 18 以上版本。

**Q：想跑多个账号？**
在对应站点的 Cookie 变量里用 `&` 或换行分隔即可，脚本会依次处理。
换行分隔更安全 —— Cookie 值本身可能含 `&`。

---

## 九、项目结构

```
glados-checkin/
├── src/
│   ├── index.js      # 入口：解析参数、汇总、推送
│   ├── checkin.js    # 签到流程：重试策略、单账号处理、自动兑换
│   ├── diagnose.js   # 排查工具：环境诊断、Cookie 自证、归属探测
│   ├── sites.js      # 站点档案（域名、变量名、会话字段）
│   ├── config.js     # 环境变量解析与 Cookie 归一化
│   ├── client.js     # API 客户端（token 推导、域名回退、响应分类）
│   └── notify.js     # 推送（PushPlus / Telegram）
├── .gitignore
├── LICENSE
└── package.json
```

两个站点共用 `client.js` 与 `checkin.js` —— 协议一致，差异全部集中在 `sites.js`。

---

## 十、免责声明

本脚本仅用于自动化**你自己账号**的每日签到，避免手动操作。
请遵守 GLaDOS / Railgun 的服务条款。因使用本脚本产生的任何后果由使用者自行承担。

## License

MIT