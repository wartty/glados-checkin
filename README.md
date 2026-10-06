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

## 二、获取 Cookie

1. 浏览器打开 <https://glados.cloud> 并登录
2. 进入 **签到页面**（Console → Checkin）
3. 按 `F12` 打开开发者工具，切到 **Network** 标签
4. 点击页面上的**签到**按钮
5. 在请求列表里找到名为 **`checkin`** 的请求，点开
6. 在 **Request Headers** 里找到 **`Cookie`** 字段，**整段复制**

格式应当形如：

```
koa:sess=eyJ1c2VySWQiOjEyMzQ1Njc4OTB9; koa:sess.sig=abcdef123456
```

> **格式要点**：分号后**必须有一个空格**，值两边**不要加引号**。
> 脚本对格式做了较强的容错（支持 JSON、裸 JWT、`Cookie:` 前缀等），但保持标准格式最稳妥。

**同时请记下你当前浏览器的 User-Agent** —— 在同一个 `checkin` 请求的 Request Headers 里能找到 `User-Agent` 字段。下一步要用。

---

## 三、青龙面板部署

### 1. 添加环境变量

青龙面板 → **环境变量** → **新建变量**：

| 变量名 | 值 | 必填 |
| --- | --- | --- |
| `GLADOS_COOKIE` | 上一步复制的 Cookie | ✅ |
| `GLADOS_USER_AGENT` | 与登录时相同的浏览器 UA | 强烈建议 |

多账号：**多次添加** `GLADOS_COOKIE` 变量，或用 `&` / 换行在单个变量里分隔。

### 2. 上传脚本

把本项目放到青龙的脚本目录下（例如 `/ql/scripts/glados-checkin/`），或通过 Git 仓库拉取。

### 3. 创建定时任务

青龙面板 → **定时任务** → **新建任务**：

| 字段 | 值 |
| --- | --- |
| 名称 | GLaDOS 签到 |
| 命令 | `node /ql/scripts/glados-checkin/src/index.js` |
| 定时规则 | `0 30 9 * * *` |

> 定时规则是 **6 位 cron**（秒 分 时 日 月 周），`0 30 9 * * *` 表示每天 09:30:00。
> 建议**避开整点**，能减少被限流的概率。

---

## 四、本地运行

```bash
# 方式一：临时指定
GLADOS_COOKIE="koa:sess=xxx; koa:sess.sig=yyy" node src/index.js

# 方式二：使用 .env
cp .env.example .env
# 编辑 .env 填入 Cookie
node src/index.js
```

---
---

## 五、配置项

全部通过环境变量配置。除 `GLADOS_COOKIE` 外均可选。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GLADOS_COOKIE` | — | **必填**。账号 Cookie，多账号用 `&` 或换行分隔 |
| `GLADOS_USER_AGENT` | Windows Chrome UA | 与登录时一致的浏览器 UA。**设备校验不通过时改这里** |
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

**Q：日志显示 `please checkin via https://glados.cloud` ？**
签到 token 失效了。GLaDOS 又改了 API 值，把 `GLADOS_CHECKIN_TOKEN` 设成日志里提示的那个域名。

**Q：日志显示 `设备校验失败 (device-mismatch)`？**
这是 2026-09 新增的设备校验。把 `GLADOS_USER_AGENT` 改成你**获取 Cookie 时那个浏览器**的完整 UA，平台必须一致（在 Windows 登录就用 Windows UA，别用 Android 或 Linux 的）。
注意此时 `status` / `points` 接口是正常的，别误以为是 Cookie 问题。

**Q：`Cookie 失效或无权限 (code=-2)`？**
Cookie 真的过期了，重新走第二步获取。GLaDOS 的 Cookie 大约 30 天失效。

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
├── .env.example
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