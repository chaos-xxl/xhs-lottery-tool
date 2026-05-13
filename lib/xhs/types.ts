/**
 * XHS 抓取客户端的公共类型与错误
 *
 * 这里只定义「任何调用方都需要共享的类型」，具体实现在 Section 3（client.ts）。
 * 先抽接口的好处：Task 2.5 author-guard / 2.7 cookie-monitor 可以依赖接口而非实现，
 * 方便单元测试 mock。
 */

// ============================================================================
// Minimal client contract（给上层模块依赖）
// ============================================================================

/**
 * 最小可依赖的 XhsClient 接口。
 *
 * Section 3 的 XhsClient 实现这个接口；单元测试里提供一个 mock 即可。
 */
export interface XhsClientLike {
  /**
   * 发起 GET 请求并返回响应 data 字段。出错抛具体 Error（401/403/461）。
   */
  get<T>(uri: string, params?: Record<string, string>): Promise<T>;
}

// ============================================================================
// Errors（跨模块共享）
// ============================================================================

export class XhsAuthError extends Error {
  readonly code = 'xhs_auth_error' as const;

  constructor(message = 'Cookie 过期或无效，请重新获取 web_session') {
    super(message);
    this.name = 'XhsAuthError';
  }
}

export class XhsRiskControlError extends Error {
  readonly code = 'xhs_risk_control' as const;

  constructor(message = '触发小红书风控（461 滑块验证），请等待冷却') {
    super(message);
    this.name = 'XhsRiskControlError';
  }
}

export class XhsApiError extends Error {
  readonly code = 'xhs_api_error' as const;

  constructor(
    readonly apiCode: number,
    readonly apiMsg: string,
  ) {
    super(`小红书接口错误 [${apiCode}]: ${apiMsg}`);
    this.name = 'XhsApiError';
  }
}

// ============================================================================
// Endpoint 返回结构（实际抓取模块 Section 3 会用）
// ============================================================================

/** 笔记详情：用于自帖校验 + 元信息 */
export interface NoteFeedResponse {
  readonly note: {
    readonly id: string;
    readonly title: string;
    readonly user: {
      readonly user_id: string;
      readonly nickname: string;
    };
    readonly time: number; // 发布时间 unix s / ms
  };
}

/** 账号状态：用于 Cookie 健康度自检 */
export interface SelfInfoResponse {
  readonly user_id: string;
  readonly nickname: string;
  /** 账号状态，某些版本返回 */
  readonly account_status?: 'normal' | 'limited' | 'banned';
}
