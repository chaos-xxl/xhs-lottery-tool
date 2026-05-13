# Requirements Document

## Introduction

xhs-lottery-system 是一个面向博主本人的网页端自用抽奖工具。它要解决的不是「有没有抽奖功能」这种表层问题，而是三件事：

1. **账号红线**——Chaos 本人使用，主号不能被封，这是本工具存在的前提而不是目标。所有能力都必须先通过 §4.3/§4.4 的护栏，再谈功能。
2. **仪式感**——粉丝在评论区留下「蹲一个」的那一刻，就开始在等这次抽奖的结果。工具要让这份等待值得被郑重对待，而不是被一串 Excel 公式打发。
3. **可审计**——commit-reveal 哈希 + 30 天内中奖去重，让「博主选了自己朋友」这种黑幕嫌疑从源头消失，无论是给自己还是给粉丝的交代。

本文档以 EARS 验收标准形式，反推自 design.md 已通过评审的技术方案，围绕账号安全 / 数据获取 / 抽奖核心 / 手动确认与去重 / 界面交互五条主线组织。所有条目只描述 **WHAT**，实现细节参见设计文档。

## Glossary

- **Lottery_System**：本系统整体，包含 Next.js Web UI 与同进程的服务端 API / Server Actions
- **XHS_Client**：调用小红书 Web 私有接口的抓取客户端，负责签名、请求节奏、错误识别
- **Author_Guard**：自帖校验模块，确认目标帖子的作者 user_id 等于当前登录账号
- **Cookie_Monitor**：Cookie 健康度自检模块，负责探测账号状态并驱动状态徽标
- **Lottery_Engine**：抽奖引擎，包含条件过滤、低质评分、HMAC-DRBG 随机抽取
- **Dedup_Manager**：30 天中奖去重管理器
- **Draw_Round**：一次完整的抽奖轮次（含规则快照、候选池、commit hash、seed、确认名单）
- **Candidate_Pool**：经过条件过滤、低质过滤、30 天去重之后进入抽奖的 user_id 有序集合
- **Interaction**：一次互动记录，类型属于 { like, collect, follow, comment } 四选其一或多
- **Win_History**：历史中奖记录表，以 (user_id, round_id) 为主键
- **Author_Cookie**：博主本人登录小红书 Web 端后得到的最小必要 Cookie 集合（web_session、a1、webId）
- **Commit_Hash**：开奖前对 seed 计算得到的 SHA-256 摘要，事前公布给用户留存
- **Seed**：HMAC-DRBG 伪随机输入，开奖时公布，配合 Commit_Hash 实现可复算审计

## Requirements

### Requirement 1：自帖校验护栏

**User Story:** 作为博主本人，我希望系统在抓取任何数据前自动确认这是我自己发布的帖子，so that 我永远不会无意中对他人帖子做批量抓取触发风控。

#### Acceptance Criteria

1. WHEN 用户提交一个帖子链接用于抓取, THE Lottery_System SHALL 在发起任何互动数据请求前先调用笔记详情接口校验帖子作者 user_id 与当前 Author_Cookie 所属账号 user_id 一致
2. IF 帖子作者 user_id 不等于当前登录账号 user_id, THEN THE Lottery_System SHALL 立即中断本次抓取流程并返回「非本人帖子」错误
3. WHILE Author_Guard 校验未通过, THE Lottery_System SHALL 禁用该帖子的所有后续抓取与开奖操作
4. WHEN Author_Guard 校验通过, THE Lottery_System SHALL 将校验结果、当前登录 user_id、帖子 note_id 一并写入本次抓取的审计日志

### Requirement 2：Cookie 健康度自检

**User Story:** 作为博主本人，我希望系统在每次启动和每次开奖前主动探测我的小红书账号状态，so that 一旦账号处于风控边缘，我能在撞上封禁之前就停下来。

#### Acceptance Criteria

1. WHEN Lottery_System 启动, THE Cookie_Monitor SHALL 在 5 秒内调用自我状态接口探测一次账号状态
2. WHEN 用户触发开奖操作, THE Cookie_Monitor SHALL 在执行抽取之前再次探测一次账号状态
3. IF 自我状态接口返回 401 或 403, THEN THE Cookie_Monitor SHALL 将 Cookie 状态标记为「失效」
4. IF 自我状态接口返回 461, THEN THE Cookie_Monitor SHALL 将 Cookie 状态标记为「滑块触发」并启动 24 小时冷却窗口
5. WHILE Cookie 状态不为「正常」, THE Lottery_System SHALL 将抓取与开奖按钮置为不可点击
6. WHILE Cookie 状态发生变化, THE Lottery_System SHALL 在 UI 顶部同步刷新对应颜色的状态徽标

### Requirement 3：请求节奏与量级护栏

**User Story:** 作为博主本人，我希望系统对小红书发出的每一次请求都卡在「人类翻页节奏」内，so that 行为指纹不会被风控识别成脚本。

#### Acceptance Criteria

1. WHEN XHS_Client 连续发起两次请求, THE XHS_Client SHALL 在两次请求之间等待至少 1500 毫秒再叠加 300 到 800 毫秒之间的随机抖动
2. WHILE 单次抓取任务进行中, THE XHS_Client SHALL 将同一账号的所有请求串行化
3. WHEN 单次帖子抓取累计条数达到 1000 条, THE XHS_Client SHALL 停止继续翻页并返回已抓取结果
4. IF XHS_Client 在单次会话内累计收到两次 461 响应, THEN THE XHS_Client SHALL 进入 1 小时冷却期并在冷却期内拒绝所有新请求
5. THE XHS_Client SHALL 仅允许调用笔记详情、点赞用户列表、收藏用户列表、评论列表、自我状态接口，不调用粉丝列表与关注列表类接口

### Requirement 4：Cookie 本地加密存储

**User Story:** 作为博主本人，我希望我的 web_session 在磁盘上从不以明文形式存在，so that 即便有人扫描我的电脑文件也无法直接读出有效 Cookie。

#### Acceptance Criteria

1. WHEN 用户首次粘贴 Cookie 到系统, THE Lottery_System SHALL 使用 AES-256-GCM 算法加密后写入本地配置文件
2. WHILE Author_Cookie 存储于本地磁盘, THE Lottery_System SHALL 确保加密密钥与密文不位于同一文件
3. WHEN 系统记录日志, THE Lottery_System SHALL 对 Cookie 字段、账号昵称以及请求体中的敏感字段执行脱敏
4. WHEN 用户点击「清除本地数据」按钮, THE Lottery_System SHALL 在 3 秒内删除加密 Cookie、SQLite 数据库文件以及所有临时文件

### Requirement 5：使用范围与数据边界

**User Story:** 作为博主本人，我希望系统在设计上就不可能超越「单用户自用」的范围，so that 工具的使用方式永远符合合规边界。

#### Acceptance Criteria

1. THE Lottery_System SHALL 仅监听本地回环地址 127.0.0.1 的服务端口
2. THE Lottery_System SHALL 仅对 Author_Guard 校验通过的帖子抓取互动数据
3. THE Lottery_System SHALL 仅存储 user_id、昵称、头像 URL、评论文本、是否关注博主、互动时间这几类字段
4. IF 系统检测到配置中包含非 127.0.0.1 的监听地址, THEN THE Lottery_System SHALL 拒绝启动并输出明确错误

### Requirement 6：小红书链接解析

**User Story:** 作为博主本人，我希望把从手机或网页随手复制的小红书链接直接粘进来，so that 我不用手动拆 URL 参数。

#### Acceptance Criteria

1. WHEN 用户提交一个 xhslink.com 形式的短链, THE Lottery_System SHALL 通过 HEAD 请求跟随 302 重定向获得完整 URL 后再进行解析
2. WHEN 用户提交一个 www.xiaohongshu.com/explore 或 /discovery/item 路径的链接, THE Lottery_System SHALL 从路径末段提取 note_id，从查询参数提取 xsec_token 与 xsec_source
3. IF 解析后 note_id 为空 OR xsec_token 为空, THEN THE Lottery_System SHALL 拒绝导入并向用户返回「链接缺少必要字段」错误
4. WHEN 链接解析成功, THE Lottery_System SHALL 将 note_id、xsec_token、作者信息、帖子标题、帖子发布时间、导入时间、原始 URL 持久化到本地数据库

### Requirement 7：互动用户抓取

**User Story:** 作为博主本人，我希望一键把一条帖子下符合条件的互动用户全部拉回本地，so that 后续所有抽奖操作都在本地数据上完成，可追溯、可复算。

#### Acceptance Criteria

1. WHEN 用户选定互动条件并触发抓取, THE XHS_Client SHALL 依据所选条件分别调用评论、点赞、收藏对应接口，并将结果按 user_id 归一合并为同一份 Interaction 快照
2. WHERE 抓取条件包含「评论」, THE XHS_Client SHALL 遍历所有一级评论并展开每条一级评论之下的二级评论
3. WHERE 抓取条件包含「关注」, THE XHS_Client SHALL 通过互动用户对象上的 followed 字段判断关注关系
4. WHEN 抓取完成, THE Lottery_System SHALL 为每个 user_id 存储完整的互动类型集合、评论文本（若有）、抓取时间戳
5. IF 抓取过程中收到 401 或 461 响应, THEN THE XHS_Client SHALL 立即停止后续请求并保留已抓取的部分结果
6. WHEN 同一帖子被多次抓取, THE Lottery_System SHALL 以最新一次抓取结果为准更新该帖子的 Interaction 快照

### Requirement 8：Cookie 导入与验证

**User Story:** 作为博主本人，我希望通过一个清晰的表单把浏览器里的 web_session 粘进来，so that 系统能以我的身份合法地调用小红书 Web 接口。

#### Acceptance Criteria

1. WHEN 用户进入 Cookie 配置页面, THE Lottery_System SHALL 显示带截图示例的粘贴输入框并列出必需字段 web_session、a1、webId
2. WHEN 用户提交 Cookie, THE Lottery_System SHALL 立即调用自我状态接口校验该 Cookie 可用性
3. IF Cookie 校验失败, THEN THE Lottery_System SHALL 拒绝保存并向用户显示具体原因（格式缺字段 / 已过期 / 滑块触发 / 其他接口错误）
4. WHEN Cookie 校验通过, THE Lottery_System SHALL 加密保存该 Cookie 并记录对应的 user_id 作为「当前登录账号」

### Requirement 9：条件过滤与 AND / OR 关系

**User Story:** 作为博主本人，我希望灵活组合点赞、收藏、关注、评论四种条件并选择 AND 或 OR 关系，so that 抽奖规则能匹配每次帖子的具体玩法。

#### Acceptance Criteria

1. WHEN 用户配置抽奖规则, THE Lottery_System SHALL 允许从 { like, collect, follow, comment } 四类互动中勾选任意非空子集
2. WHERE 规则关系为 AND, THE Lottery_Engine SHALL 仅将同时满足所有所选条件的 user_id 纳入 Candidate_Pool
3. WHERE 规则关系为 OR, THE Lottery_Engine SHALL 将至少满足一个所选条件的 user_id 纳入 Candidate_Pool
4. IF 用户提交的条件子集为空, THEN THE Lottery_System SHALL 拒绝创建 Draw_Round 并返回「至少选择一个条件」错误

### Requirement 10：低质量用户过滤

**User Story:** 作为博主本人，我希望系统自动把专职抽奖号、纯表情评论、复制粘贴话术这类低质账号从候选池里剔除，so that 中奖者更接近真正关注我内容的粉丝。

#### Acceptance Criteria

1. THE Lottery_Engine SHALL 基于账号维度（关注数、粉丝数）与评论维度（长度、纯表情、纯数字、模板话术）为每个用户计算一个取值在 0 到 1 之间的低质分
2. WHERE 用户低质分大于等于当前 Draw_Round 的低质阈值, THE Lottery_Engine SHALL 将该用户从 Candidate_Pool 中剔除
3. WHEN 某个 user_id 被低质过滤剔除, THE Lottery_System SHALL 记录该 user_id 被剔除的具体理由并在确认面板允许用户回看
4. WHERE 用户未显式设置低质阈值, THE Lottery_Engine SHALL 使用默认阈值 0.6

### Requirement 11：可验证随机抽取

**User Story:** 作为博主本人，我希望每次开奖都有一个「事前 commit 哈希、事后可复算」的证明机制，so that 无论是给我自己还是给粉丝，都能确认中奖者不是我挑出来的。

#### Acceptance Criteria

1. WHEN Lottery_Engine 准备开奖, THE Lottery_Engine SHALL 生成一个 32 字节 Seed 并对 Seed 计算 SHA-256 得到 Commit_Hash
2. WHEN Commit_Hash 生成完成, THE Lottery_System SHALL 在执行抽取之前将 Commit_Hash 呈现给用户
3. WHEN 执行抽取, THE Lottery_Engine SHALL 以 Seed 与用户本地 HMAC 密钥作为 HMAC-DRBG 输入，从 Candidate_Pool 中选出指定数量的互不重复 user_id
4. WHEN 抽取完成, THE Lottery_System SHALL 将 Seed、Commit_Hash、Candidate_Pool 快照、选出结果一同持久化到该 Draw_Round
5. IF 候选池人数小于请求的中奖人数, THEN THE Lottery_Engine SHALL 拒绝开奖并返回「候选池人数不足」错误
6. WHEN 任意第三方使用相同 Seed、Candidate_Pool 快照、中奖人数参数执行相同算法, THE Lottery_Engine SHALL 产出与当轮完全一致的中奖者顺序

### Requirement 12：规则快照与可复算

**User Story:** 作为博主本人，我希望每一轮抽奖都把当时的规则、阈值、候选池冻结下来，so that 未来复盘时结果永远能复算一致。

#### Acceptance Criteria

1. WHEN 创建一个 Draw_Round, THE Lottery_System SHALL 将条件集合、AND/OR 关系、低质阈值、当时的 30 天黑名单快照与轮次 id 绑定持久化
2. WHEN 执行开奖, THE Lottery_Engine SHALL 使用该轮次的规则快照而不是当前最新规则进行过滤
3. WHILE Draw_Round 状态为 drafted OR drawn, THE Lottery_System SHALL 拒绝对该轮次的规则字段做任何修改
4. WHEN 用户查看历史轮次, THE Lottery_System SHALL 展示规则快照、Candidate_Pool 快照、Seed 与 Commit_Hash 以支持审计

### Requirement 13：30 天内中奖去重

**User Story:** 作为博主本人，我希望一个月内已经中过奖的粉丝不会再出现在候选池，so that 奖品能更公平地分给更多粉丝，中奖不会集中在少数人身上。

#### Acceptance Criteria

1. WHEN Lottery_Engine 构建 Candidate_Pool, THE Dedup_Manager SHALL 查询 Win_History 并将 won_at 在当前时间 30 天窗口内的 user_id 排除
2. WHEN 一个 Draw_Round 被用户确认入库, THE Dedup_Manager SHALL 将本轮确认中奖者的 user_id、round_id、won_at 一并写入 Win_History
3. IF 同一 Candidate_Pool 中出现同一 user_id 两次, THEN THE Dedup_Manager SHALL 以 user_id 去重，使 Candidate_Pool 中每个 user_id 最多出现一次
4. WHERE 用户显式开启「忽略历史黑名单」开关（默认关闭）, THE Dedup_Manager SHALL 在本轮跳过 Win_History 查询
5. THE Dedup_Manager SHALL 使用「won_at ≥ now − 30 × 86400000 毫秒」这一左闭右开区间判断 30 天窗口

### Requirement 14：手动确认面板

**User Story:** 作为博主本人，我希望在最终入库前亲眼看一遍算法选出来的候选是不是都靠谱，so that 偶发的漏判我可以手动修掉而不是硬发出去。

#### Acceptance Criteria

1. WHEN Draw_Round 完成抽取, THE Lottery_System SHALL 展示候选卡片列表，每张卡片包含昵称、头像、评论文本、是否关注博主、低质分、低质剔除理由
2. THE Lottery_System SHALL 默认勾选本轮所有抽取出来的候选
3. WHEN 用户取消某个候选的勾选并点击「补抽一名」, THE Lottery_Engine SHALL 基于原 Seed 与被排除的 user_id 派生出新的 HMAC 输入并从剩余 Candidate_Pool 中抽取一名
4. WHEN 用户点击「确认入库」按钮, THE Lottery_System SHALL 弹出需要数字二次确认的弹窗并显示即将入库的人数
5. IF 用户提交的 confirmed_ids 不是 Draw_Round.selected_ids 的子集, THEN THE Lottery_System SHALL 拒绝提交并返回「存在未授权用户」错误
6. WHILE Draw_Round 状态为 confirmed, THE Lottery_System SHALL 拒绝该轮次的再次确认提交

### Requirement 15：历史中奖记录

**User Story:** 作为博主本人，我希望有一个页面能查所有帖子的历史中奖记录，so that 我可以回看每一次抽奖是谁中的、规则是什么、能不能复算出来。

#### Acceptance Criteria

1. WHEN 用户访问历史记录页, THE Lottery_System SHALL 按 confirmed_at 时间倒序展示所有状态为 confirmed 的 Draw_Round
2. THE Lottery_System SHALL 为每条记录展示帖子标题、开奖时间、中奖人数、奖品名称、Commit_Hash
3. WHEN 用户点击一条历史记录, THE Lottery_System SHALL 展开该轮次的 Seed、规则快照、Candidate_Pool、完整中奖名单以供审计
4. THE Lottery_System SHALL 永久保留 Win_History 与 Draw_Round 记录，不执行自动清理

### Requirement 16：Cookie 状态徽标与错误提示

**User Story:** 作为博主本人，我希望在每个页面的顶部都能一眼看到「账号状态是否正常」的徽标，so that 我不用多走一步就能判断现在是否能放心操作。

#### Acceptance Criteria

1. WHILE 用户使用系统, THE Lottery_System SHALL 在顶部持续显示对应 Cookie 状态的徽标（绿色表示正常、黄色表示即将过期、红色表示异常）
2. WHERE Author_Cookie 距离失效时间少于 3 天, THE Lottery_System SHALL 将徽标显示为黄色并提示「尽快更新 Cookie」
3. WHERE Cookie 状态为「失效」或「滑块触发」, THE Lottery_System SHALL 将徽标显示为红色并附带一键跳转至 Cookie 配置页的链接
4. WHEN 某项操作因 Cookie 状态异常被阻塞, THE Lottery_System SHALL 向用户显示具体原因（过期 / 滑块触发 / 接口错误）而不是通用错误

### Requirement 17：主路径交互流畅度

**User Story:** 作为博主本人，我希望主流程从「粘链接」到「确认入库」只走一条笔直的路径，so that 自用工具不给我任何需要记忆的步骤。

#### Acceptance Criteria

1. WHEN 用户进入首页, THE Lottery_System SHALL 将「粘贴新链接」作为视觉层级最高的入口
2. WHEN 链接导入成功, THE Lottery_System SHALL 自动跳转到该帖子的配置条件页面
3. WHEN 抓取任务完成, THE Lottery_System SHALL 在同一页面就近展示「开始开奖」按钮
4. WHILE 抓取或开奖任务进行中, THE Lottery_System SHALL 显示实时进度文案（已处理条数 / 已耗时）
5. IF 任一阶段出错, THEN THE Lottery_System SHALL 以可展开的错误卡片展示错误码、人话说明、建议下一步动作

### Requirement 18：自毁开关

**User Story:** 作为博主本人，我希望在顶部始终有一颗「清除 Cookie + 本地数据」的红色按钮，so that 任何怀疑设备被他人看到的场景下我能一键清场。

#### Acceptance Criteria

1. THE Lottery_System SHALL 在全局导航栏末端始终显示「清除本地数据」按钮
2. WHEN 用户点击该按钮, THE Lottery_System SHALL 弹出需要用户输入「清除」二字才能确认的对话框
3. WHEN 用户完成二次确认, THE Lottery_System SHALL 在 3 秒内删除加密 Cookie、SQLite 数据库、日志文件中的所有记录
4. WHEN 清除动作完成, THE Lottery_System SHALL 跳转到初始欢迎页并要求用户重新粘贴 Cookie

## Non-Functional Requirements

### Requirement 19：性能

#### Acceptance Criteria

1. WHEN Candidate_Pool 人数不超过 5000, THE Lottery_Engine SHALL 在 500 毫秒内完成条件过滤、低质评分与 HMAC-DRBG 抽取
2. WHEN 用户加载手动确认面板, THE Lottery_System SHALL 在 300 毫秒内完成至多 200 张候选卡片的首屏渲染
3. WHILE XHS_Client 在单次抓取过程中, THE XHS_Client SHALL 将每次请求间隔维持在 1.5 秒到 3 秒之间
4. WHEN 用户打开历史记录页, THE Lottery_System SHALL 在 500 毫秒内完成至多 100 条 Draw_Round 的列表加载

### Requirement 20：安全

#### Acceptance Criteria

1. THE Lottery_System SHALL 将所有敏感配置（Author_Cookie、HMAC 密钥、AES 加密密钥）存放在 gitignored 的本地文件中
2. THE Lottery_System SHALL 在日志写入前对 web_session、a1、webId 字段的值脱敏为固定长度的占位字符串
3. THE Lottery_System SHALL 禁止在外部请求体、错误上报、崩溃堆栈中出现 Cookie 原文
4. THE Lottery_System SHALL 仅向 edith.xiaohongshu.com 与 www.xiaohongshu.com 两个域发起外部请求

### Requirement 21：可靠性

#### Acceptance Criteria

1. WHEN XHS_Client 遇到网络超时, THE XHS_Client SHALL 重试至多 1 次，重试间隔遵守 Requirement 3 的节奏规则
2. IF SQLite 事务中任一语句失败, THEN THE Lottery_System SHALL 回滚整个事务并返回明确错误，拒绝部分写入
3. WHEN Lottery_System 启动, THE Lottery_System SHALL 先执行数据库迁移脚本将 schema 升级到最新版本再对外提供服务
4. IF 抓取过程被用户中途取消, THEN THE Lottery_System SHALL 保留已落库的 Interaction 记录并将抓取状态标记为「部分完成」

### Requirement 22：可维护性

#### Acceptance Criteria

1. THE Lottery_System SHALL 将小红书接口 URI 集中在 lib/xhs/endpoints.ts 配置模块中
2. THE Lottery_System SHALL 将签名算法封装在独立模块 lib/xhs/sign.ts 中与业务代码解耦
3. THE Lottery_System SHALL 以纯函数或明确接口的形式隔离抓取客户端、抽奖引擎、去重管理、UI 四层
4. THE Lottery_System SHALL 为 Lottery_Engine、Dedup_Manager、XHS_Client 提供独立可测的单元边界，不依赖网络即可单独运行

## Correctness Properties Candidates

> 该小节列出本需求文档预期在 design.md 中映射为可验证随机属性（Property-Based Test）的候选项。实际的属性定义与 Requirements 编号映射将在下一个阶段（Design 更新 Correctness Properties 小节）完成。

1. **抽奖幂等性（Draw Idempotence）**：对同一组 (Seed, Candidate_Pool, winner_count, user_secret) 执行抽取应产出完全相同的中奖顺序。→ 预期映射 Requirement 11、12
2. **AND/OR 过滤正确性（Filter Correctness）**：AND 模式下所有候选命中全部条件、OR 模式下所有候选至少命中一个条件。→ 预期映射 Requirement 9
3. **30 天去重保证（Dedup Guarantee）**：对任意 Candidate_Pool，Lottery_Engine 的抽取结果不应包含任何在 30 天内已确认中奖的 user_id（除非显式开启忽略开关）。→ 预期映射 Requirement 13
4. **自帖校验不可绕过（Author Guard Soundness）**：对作者 user_id 不等于当前登录 user_id 的帖子，不存在任何可达的 XHS_Client 互动请求调用路径。→ 预期映射 Requirement 1
5. **候选池充足性（Pool Sufficiency）**：当 Candidate_Pool 人数小于 winner_count 时 Lottery_Engine 必定拒绝开奖，不产出部分结果。→ 预期映射 Requirement 11

## Out of Scope

本期明确不做的能力（便于划定范围边界，避免需求蔓延）：

- 多账号管理、账号池、账号切换
- 定时自动抽奖、无人值守模式
- 微信 / 邮件 / 短信 / 小红书站内信形式的中奖通知与私信自动下发
- 将服务部署到公网供他人使用、SaaS 化
- 对他人帖子、话题聚合页、搜索结果页的批量抓取
- 对接微博、抖音、B 站、视频号等其他平台
- 自动生成公示海报、公示页面、可分享链接
- 抽奖过程的转盘动画 / 抽奖音效 / 游戏化动效（刻意不做——这是一个工具，不是玩具）
- 对小红书官方开放平台 API 的接入（个人开发者拿不到授权，详见 design.md §0）
- 粉丝关注列表的反向抓取（风控敏感，已通过 followed 字段规避）
