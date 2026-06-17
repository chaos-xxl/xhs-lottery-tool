/**
 * 基于系统 Chrome + playwright-core 的真实签名服务
 *
 * 原理：
 *   1. 启动 headless Chrome（用系统已安装的 Chrome，不下载 Chromium）
 *   2. 注入 Cookie 到 xiaohongshu.com 域
 *   3. 导航到小红书首页，等待 JS 加载完毕（window._webmsxyw 可用）
 *   4. 每次签名调用 page.evaluate(() => window._webmsxyw(url, data))
 *   5. 返回 { 'x-s': ..., 'x-t': ..., 'x-s-common': ... }
 *
 * 生命周期：
 *   - init() 启动浏览器 + 注入 Cookie + 导航（约 3-5 秒）
 *   - sign(uri, data?) 调用签名（约 50-100ms/次）
 *   - close() 关闭浏览器
 *
 * 注意：
 *   - 这个模块替代 sign.ts 的 stub 实现
 *   - 进程级单例，整个 Next.js 服务生命周期只启动一次
 *   - Cookie 过期时需要 close() + 重新 init()
 */

import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { logger } from '../config/logger';

// ============================================================================
// Types
// ============================================================================

export interface BrowserSignHeaders {
  readonly 'x-s': string;
  readonly 'x-t': string;
  readonly 'x-s-common'?: string;
  readonly 'x-b3-traceid'?: string;
}

export interface SignBrowserOptions {
  /** 完整 Cookie 字符串（所有字段） */
  readonly cookieString: string;
  /** Chrome 可执行文件路径 */
  readonly executablePath?: string;
  /** 是否 headless，默认 true */
  readonly headless?: boolean;
}

// ============================================================================
// Singleton
// ============================================================================

let instance: SignBrowserInstance | null = null;

export async function getSignBrowser(options: SignBrowserOptions): Promise<SignBrowserInstance> {
  if (instance && instance.isAlive()) {
    return instance;
  }
  instance = new SignBrowserInstance(options);
  await instance.init();
  return instance;
}

export async function closeSignBrowser(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}

// ============================================================================
// Implementation
// ============================================================================

const DEFAULT_CHROME_PATH =
  process.env.CHROME_PATH ??
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export class SignBrowserInstance {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private ready = false;
  private readonly options: SignBrowserOptions;

  constructor(options: SignBrowserOptions) {
    this.options = options;
  }

  isAlive(): boolean {
    return this.ready && this.browser !== null && this.browser.isConnected();
  }

  async init(): Promise<void> {
    const executablePath = this.options.executablePath ?? DEFAULT_CHROME_PATH;
    const headless = this.options.headless ?? true;

    logger.info({ executablePath, headless }, '启动 Chrome 签名服务...');

    this.browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-infobars',
        '--window-size=1920,1080',
        '--headless=new',
      ],
    });

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    // 反自动化检测：覆盖 navigator.webdriver
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // 覆盖 chrome.runtime 让页面认为是正常 Chrome
      (window as unknown as Record<string, unknown>).chrome = {
        runtime: {},
        loadTimes: () => ({}),
        csi: () => ({}),
        app: {},
      };
      // 覆盖 permissions query
      const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = (parameters: PermissionDescriptor) => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: 'denied' } as PermissionStatus);
        }
        return originalQuery(parameters);
      };
    });

    // 注入 Cookie
    const cookies = parseCookieString(this.options.cookieString);
    await this.context.addCookies(cookies);

    this.page = await this.context.newPage();

    // 导航到小红书首页，等待签名函数加载
    await this.page.goto('https://www.xiaohongshu.com/explore', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // 等待 _webmsxyw 函数可用（最多 10 秒）
    await this.page.waitForFunction(
      () => typeof (window as unknown as { _webmsxyw?: unknown })._webmsxyw === 'function',
      { timeout: 10_000 },
    );

    this.ready = true;
    logger.info('Chrome 签名服务就绪（_webmsxyw 已加载）');
  }

  /**
   * 调用小红书前端的 _webmsxyw 函数生成签名头。
   *
   * @param url - 请求路径（含 query），例如 '/api/sns/web/v1/user/selfinfo'
   * @param data - POST body 对象（GET 时传 undefined）
   */
  async sign(url: string, data?: unknown): Promise<BrowserSignHeaders> {
    if (!this.page || !this.ready) {
      throw new Error('签名服务未初始化，请先调用 init()');
    }

    const result = await this.page.evaluate(
      ([u, d]) => {
        const win = window as unknown as {
          _webmsxyw: (url: string, data: unknown) => Record<string, string>;
        };
        return win._webmsxyw(u, d);
      },
      [url, data ?? null] as const,
    );

    if (!result || typeof result !== 'object') {
      throw new Error('_webmsxyw 返回了非法结果');
    }

    return {
      'x-s': result['X-s'] ?? result['x-s'] ?? '',
      'x-t': result['X-t'] ?? result['x-t'] ?? '',
      'x-s-common': result['X-s-common'] ?? result['x-s-common'] ?? '',
      'x-b3-traceid': result['X-b3-traceid'] ?? result['x-b3-traceid'] ?? '',
    };
  }

  async close(): Promise<void> {
    this.ready = false;
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
    logger.info('Chrome 签名服务已关闭');
  }
}

// ============================================================================
// Helpers
// ============================================================================

function parseCookieString(
  cookieStr: string,
): Array<{ name: string; value: string; domain: string; path: string }> {
  return cookieStr
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) return null;
      const name = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      return {
        name,
        value,
        domain: '.xiaohongshu.com',
        path: '/',
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
}
