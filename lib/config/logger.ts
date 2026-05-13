/**
 * Pino 日志实例（含脱敏规则）
 *
 * 对应 requirements.md R4.3 / R20.2 / R20.3：
 *   - Cookie 字段（web_session / a1 / webId）永远不打原文
 *   - 账号昵称 / 头像 URL 也按 PII 脱敏
 *   - 请求体中的 cookie 头字段脱敏
 */

import pino from 'pino';

const SENSITIVE_PATHS = [
  'cookie',
  '*.cookie',
  'headers.cookie',
  'headers["set-cookie"]',
  'web_session',
  '*.web_session',
  'a1',
  '*.a1',
  'webId',
  '*.webId',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // 常见账号可识别字段
  '*.user_nickname',
  '*.nickname',
  '*.user_avatar',
  '*.avatar',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info'),
  redact: {
    paths: SENSITIVE_PATHS,
    censor: '[REDACTED]',
    remove: false,
  },
  base: {
    app: 'xhs-lottery-system',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * 手动脱敏：把长 Cookie 字符串处理成「xxxx****yyyy」形式，保留前 4 字符便于肉眼核对。
 * 用于不走 pino redact 的日志消息正文。
 */
export function maskSecret(value: string, visiblePrefix = 4, visibleSuffix = 0): string {
  if (!value) return '';
  if (value.length <= visiblePrefix + visibleSuffix) return '*'.repeat(value.length);
  const prefix = value.slice(0, visiblePrefix);
  const suffix = visibleSuffix > 0 ? value.slice(-visibleSuffix) : '';
  return `${prefix}****${suffix}`;
}
