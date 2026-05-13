/**
 * 小红书 Web 私有接口的 URI 常量
 *
 * 对应 requirements.md R22.1：接口路径集中在配置模块，禁止业务代码硬编码 URI。
 *
 * 签名升级或路径变更时只改这个文件。所有 URI 相对于 `https://edith.xiaohongshu.com`。
 */

export const XHS_API_BASE = 'https://edith.xiaohongshu.com' as const;

export const ENDPOINTS = {
  /** 笔记详情（自帖校验、帖子元信息） */
  noteFeed: '/api/sns/web/v1/feed',
  /** 评论分页（含二级评论） */
  commentPage: '/api/sns/web/v2/comment/page',
  /** 点赞用户列表（博主本人视角可得全量） */
  notesLiked: '/api/sns/web/v1/note/liked',
  /** 收藏用户列表 */
  notesCollected: '/api/sns/web/v1/note/collected',
  /** 自我账号状态（Cookie 健康度自检） */
  selfInfo: '/api/sns/web/v1/user/selfinfo',
} as const;

export type EndpointKey = keyof typeof ENDPOINTS;
export type EndpointUri = (typeof ENDPOINTS)[EndpointKey];

/** 允许对外发起请求的域名白名单（R20.4） */
export const ALLOWED_HOSTS = Object.freeze(['edith.xiaohongshu.com', 'www.xiaohongshu.com']);
