# 🎁 小红书抽奖工具

> 粉丝不是一堆数据，他们是赶来第一时间给你点赞的那些人。
> 抽奖不是发奖品，是把这份心意回馈得体面又公平。

## 这是什么

一个自用的小红书评论区抽奖工具。粘一条帖子链接，设好条件，抽出中奖者。

核心特点：
- **数据不离开你的电脑**：Cookie 本地 AES-256-GCM 加密存储，不上传任何第三方
- **可验证的公平**：HMAC-DRBG + commit-reveal 机制，任何人拿到 seed 都能复算出同样的结果
- **30 天去重**：同一个粉丝不会连续中奖
- **低质过滤**：自动识别纯表情、纯数字、模板套话等水评论

## 为什么做这个

作为一个小红书博主，每次抽奖都要：
1. 手动复制评论区到 Excel
2. 写公式去重 + 随机
3. 截图证明"没有黑幕"
4. 还要记住上次谁中过奖

这个流程太蠢了。我想要一个工具：粘链接 → 选条件 → 一键出结果 → 可复算证明公平。

市面上有「我们爱抽奖」这样的成熟小程序，但它需要你把 Cookie 交给第三方服务器。作为一个对数据隐私有洁癖的产品经理 + 程序员，我选择自己造一个。

## 适合谁

- ✅ 有一定技术能力的小红书博主（能跑 Docker 或 `npm run dev`）
- ✅ 在意数据隐私的人（Cookie 只在你自己机器上）
- ✅ 想要可审计抽奖结果的人（commit-reveal 哈希可复算）
- ✅ 想学习 vibe coding / spec-driven development 的开发者

## 不适合谁

- ❌ 想要"打开就能用"的博主 → 推荐「我们爱抽奖」小程序
- ❌ 没有技术背景的人
- ❌ 需要大规模批量抽奖的 MCN

## 功能清单

| 功能 | 状态 | 说明 |
|---|---|---|
| 粘贴帖子链接导入 | ✅ | 支持 explore / discovery / xhslink 短链 |
| 抓取评论列表 | ✅ | 通过浏览器自动翻页，拿到所有一级评论 |
| 条件过滤（AND/OR） | ✅ | 评论 / 点赞 / 收藏 / 关注 四选 |
| 低质评论过滤 | ✅ | 纯表情、纯数字、模板话、关注数过高 |
| HMAC-DRBG 可验证随机 | ✅ | commit hash 事前公布，seed 事后可复算 |
| 30 天中奖去重 | ✅ | 确认入库后自动排除 |
| 手动确认面板 | ✅ | 默认全选，可逐个取消 + 补抽 |
| 关注条件 | ⚠️ | 需手动确认（Web 端无法自动查询关注关系） |
| Cookie 加密存储 | ✅ | AES-256-GCM，密钥与密文物理分离 |
| 一键自毁 | ✅ | 清除 Cookie + 数据库 + 日志 |
| 点赞/收藏列表 | 🚧 | 接口已对接，部分场景可用 |

## 技术栈

```
框架      : Next.js 14 (App Router + Server Actions)
语言      : TypeScript 5 (strict)
UI        : shadcn/ui + Tailwind CSS
数据库    : SQLite (better-sqlite3 + Drizzle ORM)
签名      : Playwright + 系统 Chrome（让小红书前端 JS 自己算签名）
抽奖算法  : HMAC-DRBG (NIST SP 800-90A)
测试      : Vitest + fast-check (Property-Based Testing)
Lint      : Biome
```

## 快速开始

### 方式一：Docker（推荐）

```bash
git clone https://github.com/YOUR_USERNAME/xhs-lottery.git
cd xhs-lottery
docker compose up -d
# 打开 http://localhost:3000
```

### 方式二：本地开发

```bash
git clone https://github.com/YOUR_USERNAME/xhs-lottery.git
cd xhs-lottery
npm install
npm run db:migrate
npm run dev
# 打开 http://localhost:3000
```

### 使用步骤

1. 打开 `/cookie` 页面，从浏览器 DevTools 复制小红书 Cookie 粘贴进去
2. 回到首页，粘贴一条你自己的帖子链接
3. 选择抽奖条件（评论 / 点赞 / 收藏 / 关注）+ AND/OR 关系
4. 点击"抓取互动" → "开始开奖"
5. 在确认面板里逐个确认（关注条件需手动核实）
6. 点击"确认入库"完成

## 已知限制

- **"关注"条件需手动确认**：小红书 Web 端不返回关注关系字段，需要你点开用户主页肉眼确认
- **签名依赖本地 Chrome**：需要系统安装了 Google Chrome
- **Cookie 约 30 天过期**：过期后需要重新从浏览器复制
- **只能抓自己的帖子**：自帖校验是硬约束，不可绕过
- **不是「我们爱抽奖」的替代品**：它们有 APP 端逆向能力，功能更完整

## 项目结构

```
app/                    Next.js 页面 + API Routes
├── api/                7 个 Route Handler
├── cookie/             Cookie 配置页
├── history/            历史记录
└── posts/[id]/         帖子详情 + 开奖结果

lib/
├── config/             加密存储 + 日志脱敏
├── db/                 Drizzle schema + SQLite
├── dedup/              30 天去重
├── lottery/            抽奖算法 + 过滤 + 低质评分
├── xhs/               小红书抓取客户端 + 安全阀
└── api/               API 层共享工具

components/             shadcn/ui 组件 + 业务组件
scripts/                迁移脚本
```

## 安全设计

- Cookie AES-256-GCM 加密，密钥与密文物理分离
- 日志自动脱敏（Cookie / 昵称 / 头像字段）
- 自帖校验不可绕过（只能抓自己的帖子）
- 请求间隔 ≥ 1.5s + 随机抖动
- 连续触发风控自动冷却 1 小时
- 域名白名单（只允许请求 xiaohongshu.com）
- 一键自毁（清除所有本地数据）

## 免责声明

本项目基于小红书 Web 端浏览器自动化实现，仅供个人学习研究使用。

- 本工具**不**逆向任何 native 签名算法
- 本工具**不**维护 Cookie 池或账号池
- 本工具**不**对外提供 SaaS 服务
- 使用者需自行承担因使用本工具可能导致的账号风险
- 小红书平台策略随时可能调整，本工具不保证持续可用

## License

MIT
