# Implementation Plan: xhs-lottery-system

## Overview

把 design.md 的技术方案翻译成 Cursor 友好的小时级可执行任务清单。排序原则：**先骨架、后安全阀、再抓取、最后抽奖业务与 UI**，确保账号红线（自帖校验、Cookie 加密、健康度自检、请求节奏护栏）在任何一次真实网络请求之前就已经到位。每个业务任务在其子任务中就近写单元测试，五条 Correctness Property 的 Property-Based Test 集中放在第 7 部分，最后用端到端走查 + README 收尾。

## Conventions

- 任务粒度：每个子任务 1–3 小时，可由 Cursor 在一次对话里完成。
- 标注：`Requirements:` 指向 requirements.md 中的具体子条款编号（如 `1.1`、`3.4`）；`Property:` 指向 Correctness Properties Candidates 的序号（P1–P5）。
- 星号规则：`- [ ]* x.y` 表示可选（单元测试、PBT、集成测试）；无星号任务必须实现。
- 依赖关系：用「前置：x.y」显式标注跨节依赖。
- 签名算法边界：Task 3.3 留接口，不在本计划里硬逆向，实际实现从 `ReaJason/xhs` 或 `NanmiCoder/MediaCrawler` 社区库移植。

## Tasks

### 1. 项目脚手架

- [ ] 1. 初始化 Next.js + TypeScript 工程与工具链
  - [x] 1.1 通过 `create-next-app` 初始化工程（App Router + TS + Tailwind），锁 Node 20 LTS，提交初始骨架
    - 目录遵循 design.md §3.3 结构：`app/`、`lib/xhs/`、`lib/lottery/`、`lib/dedup/`、`lib/db/`、`lib/config/`、`scripts/`
    - `.gitignore` 显式加入 `config.local.json`、`data.db`、`*.db-journal`、`.env.local`
    - _Requirements: 20.1, 22.3_
  - [x] 1.2 安装业务依赖
    - 运行时：`better-sqlite3`、`drizzle-orm`、`drizzle-kit`、`undici`、`zod`、`react-hook-form`、`pino`、`uuid`
    - UI：`shadcn/ui` 初始化 + 常用组件（button、card、dialog、input、badge、table）
    - 开发期：`vitest`、`fast-check`、`@vitest/coverage-v8`、`tsx`、`@biomejs/biome`、`@types/better-sqlite3`
    - _Requirements: 22.3_
  - [x] 1.3 配置 Biome、tsconfig strict、`vitest.config.ts`、`drizzle.config.ts`
    - Biome 接管格式化 + lint，禁用默认 ESLint/Prettier
    - tsconfig `strict: true`、`noUncheckedIndexedAccess: true`
    - Vitest 使用 `node` 环境，支持 `lib/**` 目录下 `*.test.ts`
    - _Requirements: 22.3_
  - [ ] 1.4 配置本地服务只监听 127.0.0.1
    - `package.json` 脚本：`"dev": "next dev -H 127.0.0.1 -p 3000"`、`"start": "next start -H 127.0.0.1 -p 3000"`
    - 启动自检：若 `HOSTNAME` 非 `127.0.0.1` 则拒绝启动并输出明确错误
    - _Requirements: 5.1, 5.4_

---

### 2. 核心库单元任务（先安全阀后功能）

> 本节的顺序是硬规矩：**2.1 数据层 → 2.2 配置加密 → 2.3 自帖校验 → 2.4 Cookie 健康度自检 → 2.5 请求节奏护栏**，这五个任务完成前不允许做任何真实抓取调用。之后才是链接解析、签名、客户端、互动抓取、过滤、评分、抽奖、去重。

- [ ] 2. 核心库 - 数据与安全阀（优先）
  - [x] 2.1 定义 Drizzle schema 与迁移
    - 文件：`lib/db/schema.ts`、`lib/db/index.ts`、`scripts/migrate.ts`、`drizzle/migrations/*`
    - 表：`posts`、`interactions`、`draw_rounds`（含 `rules` JSON、`seed`、`commit_hash`、`candidate_ids`、`selected_ids`、`confirmed_ids`、`status`）、`win_history`（复合主键 `(user_id, round_id)`）
    - 索引：`idx_win_history_user_won_at`、`idx_win_history_won_at`
    - 启动时自动执行迁移（对接 Req 21.3）
    - _Requirements: 6.4, 7.4, 11.4, 12.1, 13.2, 15.4, 21.3_
    - _前置：1.2_
  - [x]* 2.2 编写 schema 迁移单元测试
    - 在内存 SQLite 中跑一次迁移，断言所有表、索引、主键存在
    - 测试 `win_history` 复合主键约束（同 user_id 同 round_id 重复插入应被 `ON CONFLICT DO NOTHING` 吸收）
    - _Requirements: 13.2, 21.3_
  - [x] 2.3 实现 AES-256-GCM 加密存储模块 `lib/config/secure-store.ts`
    - 接口：`setCookie(cookieRaw)`、`getCookie()`、`clearAll()`、`probeCookieHealth()` 的读取侧
    - 密钥来源：`~/.kiro/xhs-lottery/master.key`（首次启动生成 32 字节），与密文文件 `config.local.json` 物理分离
    - 数据结构：`{ iv, ciphertext, tag, created_at, last_validated_at, account_user_id? }`
    - 所有路径 / 日志脱敏（Cookie 值永远打星号）
    - _Requirements: 4.1, 4.2, 4.3, 20.1, 20.2, 20.3_
    - _前置：1.3_
  - [x]* 2.4 编写 secure-store 单元测试
    - 密钥文件与密文文件在不同路径
    - 读写对称性（加密 → 解密结果严格相等）
    - 日志脱敏断言（Cookie 字符串不得在 pino 输出中出现原文）
    - _Requirements: 4.1, 4.3, 20.2_
  - [x] 2.5 实现自帖校验 `lib/xhs/author-guard.ts`
    - 对外接口：`ensureSelfPost(noteId, xsecToken, currentUserId): Promise<AuthorGuardResult>`
    - 返回 `{ ok: true, authorId, noteId }` 或 `{ ok: false, reason }`
    - 内部调用笔记详情接口（通过 XhsClient 注入，便于 mock）
    - 写入审计日志：`{ ts, action: 'author_guard', currentUserId, authorId, noteId, result }`
    - 所有业务入口（抓取、开奖、补抽）必须经过本函数返回 ok 才能继续
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
    - _前置：2.1、2.3；依赖但暂 mock 3.5 的 XhsClient_
  - [x]* 2.6 编写自帖校验单元测试（mock XhsClient）
    - 作者一致 → ok
    - 作者不一致 → `ok: false, reason: 'not_self_post'`
    - 接口 401/461 → 向上传播对应错误，不允许「模糊通过」
    - 审计日志字段完整
    - _Requirements: 1.1, 1.2, 1.4_
  - [x] 2.7 实现 Cookie 健康度自检 `lib/xhs/cookie-monitor.ts`
    - 对外接口：`probe(): Promise<CookieStatus>`、`getStatus(): CookieStatus`、事件订阅 `onChange(listener)`
    - 状态枚举：`'healthy' | 'expiring_soon' | 'expired' | 'challenge_required' | 'unknown'`
    - 启动时自动 probe（5 秒内）；开奖前显式 probe
    - 命中 461 → 状态置 `challenge_required` 并开启 24 小时冷却戳
    - 命中 401/403 → 状态置 `expired`
    - 接近过期（距 `web_session` expires 不足 3 天）→ `expiring_soon`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 16.1, 16.2, 16.3_
    - _前置：2.3_
  - [x]* 2.8 编写 cookie-monitor 单元测试（mock 自我状态接口）
    - 各状态转换路径
    - 24 小时冷却期内 probe 不再触发真实调用
    - _Requirements: 2.3, 2.4_
  - [x] 2.9 实现请求节奏护栏 `lib/xhs/rate-limiter.ts`
    - 对外接口：`run<T>(fn: () => Promise<T>): Promise<T>`，内部保证最小间隔 1500 ms + 300–800 ms 随机抖动
    - 单账号全局串行队列（防止并发 cookie 命中）
    - 461 计数器：同会话累计 2 次即进入 1 小时冷却，冷却期内 `run` 直接 reject
    - 单次抓取会话内累计条数到达 1000 时，返回 `PoolCappedSignal` 让上层停止翻页
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [x]* 2.10 编写 rate-limiter 单元测试（使用假时钟）
    - 两次 `run` 间隔 ≥ 1500 ms
    - 并发提交多个 fn 严格串行执行
    - 连续两个 461 触发冷却、第三次调用被拒
    - _Requirements: 3.1, 3.2, 3.4_

- [ ] 3. 核心库 - XHS 抓取客户端
  - [x] 3.1 实现链接解析 `lib/xhs/parse-url.ts`
    - 支持 `https://www.xiaohongshu.com/explore/{noteId}?xsec_token=...`
    - 支持 `https://www.xiaohongshu.com/discovery/item/{noteId}?xsec_token=...`
    - 支持 `http://xhslink.com/a/*` 短链：`fetch(url, { method: 'HEAD', redirect: 'manual' })` 跟随 302 拿 Location
    - 缺 `note_id` 或 `xsec_token` → 抛 `LinkParseError('链接缺少必要字段')`
    - _Requirements: 6.1, 6.2, 6.3_
  - [x]* 3.2 编写 parse-url 单元测试
    - 三种链接形态的正样本
    - 缺字段 / 非法域名 / 错拼写的负样本
    - mock `fetch` 验证短链展开路径
    - _Requirements: 6.1, 6.2, 6.3_
  - [x] 3.3 签名封装 `lib/xhs/sign.ts`（留接口，不自逆向）
    - 对外只暴露 `sign(input: SignInput): SignHeaders`
    - 内部 `computeXs`、`mrc`、常量 `FIXED_B1` 独立可替换
    - **实现来源：从 `ReaJason/xhs`（Python）或 `NanmiCoder/MediaCrawler` 移植 JS 等价实现**，本任务只做接口、目录与 TODO 注释 + 一份可运行的占位桩（返回占位头，供非真实调用的单元测试使用）
    - 在 README-dev.md 中记录社区参考来源与升级 checklist
    - _Requirements: 22.2_
  - [x] 3.4 集中配置 endpoints `lib/xhs/endpoints.ts`
    - 抽出：笔记详情、评论分页、点赞用户、收藏用户、自我状态五个 URI，全部做成可替换常量
    - 绝不允许在业务代码里硬编码 URI
    - _Requirements: 3.5, 22.1_
  - [x] 3.5 实现 `XhsClient` 请求封装 `lib/xhs/client.ts`
    - 注入：cookie（经 secure-store 解密）、rate-limiter、sign、endpoints
    - 统一 header：`x-s / x-t / x-s-common / x-b3-traceid` + `user-agent` + `referer` + `origin`
    - 状态码处理：461 → `XhsRiskControlError`（冷却）、401/403 → `XhsAuthError`、`success=false` → `XhsApiError`
    - 仅允许访问 Req 20.4 约束的域名；任何其他域名调用直接抛异常
    - 请求/响应日志对 Cookie 与 user 字段脱敏
    - _Requirements: 3.1, 3.2, 3.5, 7.5, 20.3, 20.4, 22.1_
    - _前置：2.3、2.9、3.3、3.4_
  - [x]* 3.6 编写 XhsClient 单元测试（mock `undici` fetch）
    - 401 → `XhsAuthError`
    - 461 → `XhsRiskControlError` 且 rate-limiter 收到计数
    - 超时重试至多 1 次（对接 Req 21.1）
    - 非白名单域名调用 → 抛异常
    - _Requirements: 3.1, 7.5, 20.4, 21.1_
  - [x] 3.7 实现互动用户抓取器 `lib/xhs/fetch-interactions.ts`
    - 对外：`fetchInteractions(client, post, conditions): Promise<Map<user_id, Interaction>>`
    - 评论：遍历 `/api/sns/web/v2/comment/page` + 每条的 `sub_comments`
    - 点赞：遍历 `/api/sns/web/v1/note/liked`（博主本人 Cookie 才能拿全）
    - 收藏：遍历 `/api/sns/web/v1/note/collected`；拿不到全量则记录告警
    - 关注：从点赞/评论对象的 `followed` 字段读取，**不调粉丝列表接口**
    - `mergeUser` 按 user_id 归一合并 types + 首个 comment_text
    - 收到 401/461 立即停止并保留已抓结果
    - 单次累计达 1000 条时由 rate-limiter 信号中断翻页
    - _Requirements: 3.3, 3.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
    - _前置：2.5、2.9、3.5_
  - [x]* 3.8 编写 fetch-interactions 单元测试
    - 评论 + 二级评论归一
    - 同一用户同时点赞与评论 → types 合并为 `['like','comment']`
    - 401 中途中断 → 返回已抓部分、不抛未捕获异常
    - 模拟 1000 条上限触发中断
    - _Requirements: 7.1, 7.2, 7.5_

- [ ] 4. 核心库 - 抽奖引擎与去重
  - [x] 4.1 实现 BitSet AND/OR 过滤器 `lib/lottery/filter.ts`
    - `buildUserBits(i)`、`buildRuleMask(conditions)`、`matches(userBits, mask, relation)`
    - 对外：`filterCandidates(users, rules, blacklist): Interaction[]`
    - 条件子集为空 → 抛 `EmptyConditionError`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_
  - [x]* 4.2 编写 filter 单元测试（示例 + 边界）
    - AND 模式全中 / 缺一
    - OR 模式至少一个命中 / 全不中
    - 空条件拒绝
    - _Requirements: 9.1, 9.2, 9.3, 9.4_
    - _Property: P2（PBT 放到 7.2）_
  - [x] 4.3 实现低质评分 `lib/lottery/quality.ts`
    - 按 design.md §2.4 权重表计算 total ∈ [0,1] + reasons[]
    - 字段齐全度容错：缺 `user_fans_count` 时不加分也不崩
    - 默认阈值 0.6（未显式配置时使用）
    - 评论规则集做成常量导出，便于后续调阈值
    - _Requirements: 10.1, 10.2, 10.3, 10.4_
  - [x]* 4.4 编写 quality 单元测试
    - 典型羊毛号（关注 > 2000、纯表情评论）→ total ≥ 0.6
    - 正常粉丝长评论 → total < 0.3
    - 缺失字段不抛异常
    - reasons 列表包含可读中文理由
    - _Requirements: 10.1, 10.2, 10.3_
  - [x] 4.5 实现 HMAC-DRBG commit-reveal 抽奖 `lib/lottery/draw.ts`
    - `draw({ poolIds, winnerCount, userSecret }): DrawResult`
    - `verify({ poolIds, winnerCount, userSecret, seed, publishedWinners })`
    - 候选池 < winnerCount → 抛 `PoolInsufficientError`
    - poolIds 在入口即用 Set 去重，保证同一 user_id 只能中一次
    - Seed 32 bytes、Commit_Hash = SHA-256(seed)
    - 补抽模式 `derive(seed, excludedIds)`：派生新 HMAC 输入（原 seed + 排除名单序列化字符串），可复算
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 12.2, 14.3_
  - [x]* 4.6 编写 draw 单元测试（示例 + 边界）
    - 幂等性：固定输入 → 固定 winners 顺序
    - commit = SHA256(seed) 校验
    - pool < winnerCount → 抛错，不产出部分结果
    - 补抽派生：相同 excluded 集合 → 相同新 winner；不同 excluded → 不同 winner
    - _Requirements: 11.1, 11.3, 11.5, 11.6, 14.3_
    - _Property: P1、P5（PBT 放到 7.1、7.5）_
  - [x] 4.7 实现 30 天去重 `lib/dedup/win-history.ts`
    - `getRecentWinners(db, windowDays=30): Set<string>`（用 `won_at >= now - 30*86_400_000`，左闭右开）
    - `commitWinners(db, round, confirmedIds)`：`INSERT ... ON CONFLICT DO NOTHING` + 单事务
    - 规则快照：建 round 时把「当时的黑名单集合」连同规则一起落到 `draw_rounds.rules_snapshot.blacklist_at_draw`
    - 支持 `ignoreBlacklist: true` 开关（UI 默认关闭）
    - _Requirements: 12.1, 12.2, 13.1, 13.2, 13.3, 13.4, 13.5, 15.4, 21.2_
    - _前置：2.1_
  - [x]* 4.8 编写 win-history 单元测试
    - 30 天窗口边界：第 29 天命中、第 30 天精确边界、第 31 天不命中
    - 同一 round_id 重复确认 → 只有首次写入
    - `ignoreBlacklist` 开启时黑名单查询被跳过
    - 事务失败 → 全部回滚（对接 Req 21.2）
    - _Requirements: 13.1, 13.2, 13.5, 21.2_
    - _Property: P3（PBT 放到 7.3）_

- [ ] 5. Checkpoint - 核心库测试闭环
  - 所有 Section 2–4 的单元测试本地通过；确保 `npm run test` 干净；遇到疑问主动询问用户。

---

### 6. Server API 层

- [ ] 6. Next.js Route Handlers / Server Actions
  - [x] 6.1 `POST /api/cookie`（Cookie 导入 + 即时自检）
    - 入参 Zod 校验：`web_session`、`a1`、`webId` 必填
    - 流程：secure-store 加密保存 → cookie-monitor.probe() → 校验通过则回写 `account_user_id` 并返回 `{ ok, status, accountUserId }`；失败返回具体原因
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 16.4_
    - _前置：2.3、2.7_
  - [ ]* 6.2 `/api/cookie` 集成测试（mock XhsClient）
    - 合法 Cookie → 落盘且 status = healthy
    - 缺字段 / 401 / 461 分别返回不同错误消息
    - _Requirements: 8.3, 16.4_
  - [x] 6.3 `POST /api/posts/import`（链接导入）
    - 流程：parse-url → ensureSelfPost → 落 `posts` 表（含 noteId / xsecToken / 作者信息 / 标题 / 发布时间 / 原始 URL / 导入时间）
    - 作者非本人 → 403 + `not_self_post` 错误码
    - _Requirements: 1.1, 1.2, 1.4, 5.2, 6.1, 6.2, 6.3, 6.4_
    - _前置：2.1、2.5、3.1_
  - [ ]* 6.4 `/api/posts/import` 集成测试
    - 自帖通过 / 他人帖被拒 / 缺 xsec_token 被拒
    - _Requirements: 1.2, 6.3_
    - _Property: P4（PBT 放到 7.4）_
  - [x] 6.5 `POST /api/posts/:id/fetch`（抓取互动）
    - 前置检查：cookie-monitor 状态必须是 healthy；author-guard 再查一次；否则 409 + 原因
    - 执行 `fetchInteractions`，结果 UPSERT 到 `interactions`（最新一次为准，对接 Req 7.6）
    - 中途 401/461 → 返回已抓结果 + 告警码 `partial_success`
    - _Requirements: 1.3, 2.5, 7.1, 7.4, 7.5, 7.6, 21.4_
    - _前置：2.5、2.7、2.9、3.7_
  - [x] 6.6 `POST /api/rounds`（开奖 commit-reveal）
    - 入参：`postId`、`conditions`、`relation`、`filters`、`winnerCount`、`prizeName`、`ignoreBlacklist?`
    - 流程：cookie-monitor.probe() → 取 interactions → dedup.getRecentWinners 作为 blacklist → filter → quality → draw.draw(...)
    - 落 `draw_rounds`：`rules_snapshot`、`candidate_ids`、`selected_ids`、`seed`、`commit_hash`、`status='drawn'`
    - 返回 `{ roundId, commitHash, candidates, selectedCandidates }`
    - 候选池不足 → 422 + `pool_insufficient`
    - _Requirements: 2.2, 9.1–9.4, 10.1–10.4, 11.1–11.6, 12.1, 12.2, 13.1, 13.4_
    - _前置：2.7、4.1、4.3、4.5、4.7_
  - [ ]* 6.7 `/api/rounds` 集成测试
    - 正常流程返回合法 commit_hash
    - 候选池 < winnerCount → 422
    - `ignoreBlacklist` 开关生效
    - _Requirements: 11.5, 13.4_
  - [x] 6.8 `POST /api/rounds/:id/confirm`（确认入库）
    - 校验 `confirmed_ids ⊆ selected_ids`，否则 400 `unauthorized_user`
    - 校验当前 round.status = `drawn`，否则 409 `already_confirmed`
    - 单事务：INSERT win_history + UPDATE round.status=`confirmed` + `confirmed_ids` + `confirmed_at`
    - 返回 `{ ok, nextTimeBlacklisted }`
    - _Requirements: 12.3, 13.2, 14.4, 14.5, 14.6, 21.2_
    - _前置：4.7_
  - [ ]* 6.9 `/api/rounds/:id/confirm` 集成测试
    - 子集关系校验
    - 重复确认被拒
    - 事务原子性：模拟第二条插入失败 → 回滚
    - _Requirements: 14.5, 14.6, 21.2_
  - [x] 6.10 `POST /api/rounds/:id/redraw`（补抽）
    - 入参：`excludeIds[]`
    - 校验 `excludeIds ⊆ selected_ids`
    - 调用 `draw.derive(seed, excludeIds)` 从剩余候选池抽 1 名；更新 round.selected_ids（记录派生过程供审计）
    - _Requirements: 14.3_
    - _前置：4.5_
  - [ ]* 6.11 `/api/rounds/:id/redraw` 集成测试
    - 相同排除集合 → 相同新 winner（幂等）
    - 排除了不在 selected 中的 id → 拒绝
    - _Requirements: 14.3_
  - [x] 6.12 `DELETE /api/self-destruct`（自毁）
    - 前端需要在 header 传 `x-confirm: 清除`
    - 顺序删除：加密 Cookie 文件 → SQLite 文件 → 日志文件 → master.key
    - 3 秒超时硬保证（Req 18.3）
    - _Requirements: 4.4, 18.1, 18.2, 18.3, 18.4_
    - _前置：2.3_
  - [ ]* 6.13 `/api/self-destruct` 集成测试
    - 缺少 confirm header → 400
    - 删除后再查 `/api/cookie` 状态 → 空 + 引导重新粘贴
    - _Requirements: 4.4, 18.3_

---

### 7. Web UI 层（shadcn/ui + Tailwind）

- [ ] 7. 前端页面与交互
  - [x] 7.1 全局布局 `app/layout.tsx`
    - 顶部导航：Logo + Cookie 状态徽标（绿/黄/红三态，含文字说明）+ 「清除本地数据」红色按钮
    - 徽标点击跳转 `/cookie`
    - 自毁按钮弹出需输入「清除」二字的 shadcn Dialog
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 18.1, 18.2, 18.4_
    - _前置：6.1、6.12_
  - [x] 7.2 Cookie 配置页 `app/cookie/page.tsx`
    - 粘贴输入框 + 截图示例卡片（从浏览器 DevTools → Application → Cookies 取 web_session/a1/webId）
    - 表单校验：三字段齐全 + 长度合理
    - 提交 → `/api/cookie` → 成功 Toast / 失败可展开错误卡（错误码 + 人话 + 建议）
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 17.5_
    - _前置：6.1、7.1_
  - [x] 7.3 首页 `app/page.tsx`
    - 视觉层级最高的「粘贴新链接」大输入框 + CTA
    - 下方：帖子列表（标题、发布时间、导入时间、最近一次抓取时间）
    - 提交链接 → 调 `/api/posts/import` → 成功自动跳 `/posts/[id]`
    - _Requirements: 6.1, 6.2, 17.1, 17.2_
    - _前置：6.3、7.1_
  - [x] 7.4 帖子详情页 `app/posts/[id]/page.tsx`
    - 顶部帖子元信息
    - 条件配置区：四个互动勾选 + AND/OR 切换 + 低质阈值滑块 + 中奖人数 + 奖品名 + 「忽略 30 天黑名单」开关（默认关）
    - 「抓取互动」按钮 → 进度文案（已抓 X 条 / 耗时 Y 秒），调 `/api/posts/:id/fetch`
    - 抓取完成 → 就近展示「开始开奖」按钮
    - 空条件 / 失败 → 可展开错误卡
    - _Requirements: 9.1, 9.4, 10.4, 13.4, 17.3, 17.4, 17.5_
    - _前置：6.5、6.6、7.1_
  - [x] 7.5 开奖结果与手动确认面板 `app/posts/[id]/rounds/[roundId]/page.tsx`
    - 顶部：Commit_Hash 卡片 + 一键复制（开奖前可先亮出来给粉丝公示）
    - 候选卡片列表：头像、昵称、评论高亮、`followed` 徽标、低质分与被剔除理由（若展开完整池子）、默认全选
    - 取消勾选时显示「补抽一名」按钮 → 调 `/api/rounds/:id/redraw`
    - 「确认入库」按钮弹出数字二次确认 Dialog（显示即将入库人数）
    - 确认成功 → 展示「✅ 已入库，下次抽奖自动排除这 N 人」Toast
    - _Requirements: 11.2, 14.1, 14.2, 14.3, 14.4, 19.2_
    - _前置：6.6、6.8、6.10、7.1_
  - [x] 7.6 历史记录页 `app/history/page.tsx`
    - 按 `confirmed_at` 倒序列表：帖子标题、开奖时间、中奖人数、奖品名、Commit_Hash（前 8 位 + 复制按钮）
    - 点击展开：Seed、规则快照、Candidate_Pool、完整中奖名单
    - 列表首屏 ≤ 100 条在 500 ms 内渲染（对接 Req 19.4）
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 19.4_
    - _前置：6.8、7.1_
  - [ ]* 7.7 关键交互的 React 组件单元测试
    - Cookie 徽标的三态渲染
    - 自毁 Dialog 输错文案时「确认」按钮 disabled
    - 手动确认面板默认全选 + 取消后出现「补抽」按钮
    - _Requirements: 14.2, 16.1, 18.2_

---

### 8. Property-Based 测试（五条 Correctness Property）

> 集中在本节，使用 Vitest + fast-check；每条 Property 独立一个 test 文件，便于 CI 里单独失败定位。所有 PBT 任务均为可选（`*`），但强烈建议跑通——它们是对 requirements.md §Correctness Properties 的直接映射。

- [ ] 8. 五条 Correctness Property 的 PBT
  - [x]* 8.1 **Property 1：抽奖幂等性（Draw Idempotence）**
    - 文件：`lib/lottery/draw.pbt.test.ts`
    - 生成：任意 `poolIds` (去重 + 长度 ≥ winnerCount)、`winnerCount ∈ [1, pool.length]`、`userSecret`、`seed`
    - 断言：同一组 (Seed, Pool, winnerCount, userSecret) 两次独立执行，winners 数组严格相等
    - _Validates: Requirements 11.3, 11.6, 12.2_
    - _Property: P1_
  - [x]* 8.2 **Property 2：AND/OR 过滤正确性（Filter Correctness）**
    - 文件：`lib/lottery/filter.pbt.test.ts`
    - 生成：任意 `users` (每个带 types ⊆ {like,collect,follow,comment})、`conditions` (非空子集)、`relation ∈ {'AND','OR'}`
    - 断言：
      - `relation='AND'` 时候选池每个用户的 types 包含全部 conditions
      - `relation='OR'` 时候选池每个用户的 types 至少包含一条 conditions
      - 所有候选都不在 blacklist 中
    - _Validates: Requirements 9.2, 9.3_
    - _Property: P2_
  - [x]* 8.3 **Property 3：30 天去重保证（Dedup Guarantee）**
    - 文件：`lib/dedup/win-history.pbt.test.ts`
    - 生成：任意 `users`（部分带 `last_won_at` 分布在 0~60 天前）、`ignoreBlacklist ∈ {true,false}`
    - 断言：
      - `ignoreBlacklist=false`：Candidate_Pool ∩ { u | now - u.last_won_at ≤ 30*86400000 } = ∅
      - `ignoreBlacklist=true`：黑名单查询被跳过，池子包含窗口内中过奖的 user（如果其他条件都满足）
    - _Validates: Requirements 13.1, 13.4, 13.5_
    - _Property: P3_
  - [ ]* 8.4 **Property 4：自帖校验不可绕过（Author Guard Soundness）**
    - 文件：`lib/xhs/author-guard.pbt.test.ts`
    - 策略：生成任意 `currentUserId ≠ authorId` 组合，对 `fetchInteractions`、`/api/posts/:id/fetch`、`/api/rounds` 三条路径做调用
    - 断言：任意一次调用都不会触达 `XhsClient` 的评论/点赞/收藏接口（通过 spy mock 断言）；均被 `AuthorGuardError` 或 HTTP 403 拦截
    - _Validates: Requirements 1.1, 1.2, 1.3, 5.2_
    - _Property: P4_
  - [x]* 8.5 **Property 5：候选池充足性（Pool Sufficiency）**
    - 文件：`lib/lottery/pool-sufficiency.pbt.test.ts`
    - 生成：任意 `poolIds` 与 `winnerCount`，其中 30% 概率触发 `pool.length < winnerCount`
    - 断言：
      - `pool.length < winnerCount` → `draw()` 抛 `PoolInsufficientError`，DB 中 **不存在** 任何 `status='drawn'` 的新 round 写入（事务回滚）
      - `pool.length ≥ winnerCount` → winners.length 严格等于 winnerCount
    - _Validates: Requirements 11.5_
    - _Property: P5_

---

### 9. 端到端验证与文档

- [ ] 9. 收尾
  - [ ] 9.1 手动走一次完整主路径（本地）
    - 准备：浏览器 Chrome 登录小红书 → 粘 Cookie 到 `/cookie` → 状态徽标变绿
    - 粘贴自己的一条真实帖子链接 → 抓取 → 开奖（选 AND=like+comment、winnerCount=3） → 手动确认 → 查历史记录
    - 再跑一次同一帖子：确认 30 天黑名单生效
    - 将走查清单与截图记录到 `docs/e2e-walkthrough.md`
    - _Requirements: 17.1, 17.2, 17.3, 17.4_
  - [ ]* 9.2 端到端冒烟脚本（Playwright，可选）
    - 仅跑 Mock 模式：环境变量 `XHS_MOCK=1` 时 XhsClient 返回本地固定 fixtures
    - 覆盖：Cookie 导入 → 链接导入 → 抓取 → 开奖 → 确认 → 历史
    - _Requirements: 17.1–17.5_
  - [ ] 9.3 编写 `README.md` + 合规免责声明
    - 项目介绍：一段话讲清楚「自用工具、授权 Cookie 路线、合规边界」
    - 快速开始：6 行命令（clone → install → migrate → run → 粘 Cookie → 开奖）
    - 技术栈清单与目录地图（来自 design.md §3.2/§3.3）
    - **合规与风险章节**（必须显眼）：
      - 授权 Cookie 路线的本质：以博主本人身份调用 Web 接口，数据来源是博主自己的帖子与互动用户
      - 本工具**不**用于对他人帖子、话题聚合页、搜索结果页的批量抓取
      - 本工具**不**做多账号、账号池、定时任务、SaaS 化、海报生成
      - 平台接口策略随时可能调整，签名算法升级需跟踪社区库（`ReaJason/xhs`、`NanmiCoder/MediaCrawler`）
      - 用户一次性粘贴 Cookie 即表示知悉并承担对应账号风险
    - Cookie 获取图文教程（链接到 `/cookie` 页面内置截图）
    - FAQ：什么时候徽标变红 / 触发 461 怎么办 / 如何一键自毁
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [ ] 9.4 终版 Checkpoint
    - 跑一轮完整 `npm run test`（含 PBT 可选项按需打开）
    - 跑 `npm run build` 确认无类型与 lint 错误
    - 遇到疑问主动询问用户，再决定是否进入真实使用

## Notes

- 带 `*` 号的子任务为可选（单元测试、PBT、集成测试、冒烟脚本）；其余为核心实现任务，必须完成。
- **顺序不能乱**：Section 2 的五个安全阀（数据层 / Cookie 加密 / 自帖校验 / Cookie 健康度自检 / 请求节奏）必须早于 Section 3 的真实抓取客户端实现。
- **签名算法不硬逆向**：Task 3.3 仅定义接口与占位桩，真实 `computeXs / mrc` 从社区库移植，维护视社区发布节奏。
- **PBT 与 Correctness Properties 一一对应**：P1↔8.1、P2↔8.2、P3↔8.3、P4↔8.4、P5↔8.5，每条单独失败可定位。
- **Checkpoint 意义**：Section 5 与 9.4 的 Checkpoint 是主动停下来问用户的节点，避免进入下一阶段才发现上一阶段有偏差。
- **本工作流仅创建设计与规划工件**：tasks.md 生成后本工作流结束。用户可以打开 tasks.md，点击任一任务左侧的「Start task」开始执行。
