/**
 * AES-256-GCM 加密存储（本地 Cookie / 敏感配置）
 *
 * 对应 requirements.md R4（Cookie 本地加密）、R18（自毁开关）、R20（安全）。
 *
 * 关键设计：
 *   - 算法：AES-256-GCM（认证加密，自带完整性校验）
 *   - master key：32 字节，首次启动生成，写入 ~/.kiro/xhs-lottery/master.key，与密文分离（R4.2）
 *   - 密钥文件权限：0600（仅所有者可读写）
 *   - 每次写入都重新生成 12 字节 IV（GCM 严格不能复用 IV）
 *   - 返回/接受明文：调用方负责及时 GC
 *   - clearAll()：顺序删除密文 → 密钥 → 日志（R18.3，3 秒内硬保证）
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';
import { resolveLocalPaths } from './paths';

const ALGORITHM = 'aes-256-gcm' as const;
const KEY_LENGTH = 32; // 256 bit
const IV_LENGTH = 12; // GCM 推荐 96 bit
const TAG_LENGTH = 16; // GCM authentication tag

// ============================================================================
// Types
// ============================================================================

export interface CookieBundle {
  /** 必需：w 登录会话 */
  readonly web_session: string;
  /** 必需：设备指纹 */
  readonly a1: string;
  /** 必需：web 侧身份 */
  readonly webId: string;
  /** 可选：其他透传字段（某些接口可能需要） */
  readonly [extra: string]: string;
}

export interface StoredConfigFile {
  readonly version: 1;
  readonly iv: string; // hex
  readonly ciphertext: string; // hex
  readonly tag: string; // hex
  readonly createdAt: number; // unix ms
  readonly lastValidatedAt: number | null; // unix ms
  readonly accountUserId: string | null;
}

export interface SecureStoreOptions {
  readonly homeDir?: string;
  readonly projectDir?: string;
}

// ============================================================================
// Errors
// ============================================================================

export class SecureStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'master_key_missing'
      | 'config_missing'
      | 'decrypt_failed'
      | 'schema_invalid'
      | 'io_error',
  ) {
    super(message);
    this.name = 'SecureStoreError';
  }
}

// ============================================================================
// Master Key
// ============================================================================

/**
 * 读取 master key；不存在则自动生成并以 0600 权限写入。
 */
function loadOrCreateMasterKey(masterKeyFile: string): Buffer {
  const dir = path.dirname(masterKeyFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(masterKeyFile)) {
    const key = fs.readFileSync(masterKeyFile);
    if (key.length !== KEY_LENGTH) {
      throw new SecureStoreError(
        `master key 长度异常（期望 ${KEY_LENGTH}，实际 ${key.length}）`,
        'schema_invalid',
      );
    }
    return key;
  }

  const key = randomBytes(KEY_LENGTH);
  fs.writeFileSync(masterKeyFile, key, { mode: 0o600 });
  logger.info({ file: maskPath(masterKeyFile) }, 'master key 首次生成（AES-256），已落盘 0600');
  return key;
}

// ============================================================================
// API
// ============================================================================

export class SecureStore {
  private readonly paths: ReturnType<typeof resolveLocalPaths>;

  constructor(options: SecureStoreOptions = {}) {
    this.paths = resolveLocalPaths(options);
  }

  /**
   * 写入 Cookie 并加密落盘。
   */
  setCookie(cookie: CookieBundle): void {
    this.assertCookieShape(cookie);

    const key = loadOrCreateMasterKey(this.paths.masterKeyFile);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const plaintext = Buffer.from(JSON.stringify(cookie), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const existing = this.safeReadConfig();

    const file: StoredConfigFile = {
      version: 1,
      iv: iv.toString('hex'),
      ciphertext: encrypted.toString('hex'),
      tag: tag.toString('hex'),
      createdAt: existing?.createdAt ?? Date.now(),
      lastValidatedAt: null,
      accountUserId: existing?.accountUserId ?? null,
    };

    this.writeConfigAtomic(file);

    logger.info(
      {
        path: maskPath(this.paths.configFile),
        createdAt: file.createdAt,
      },
      'Cookie 已 AES-256-GCM 加密写入 config.local.json',
    );
  }

  /**
   * 解密并返回 Cookie。不存在 / 解密失败会抛 SecureStoreError。
   */
  getCookie(): CookieBundle {
    const file = this.readConfigOrThrow();
    const key = this.readMasterKeyOrThrow();

    const iv = Buffer.from(file.iv, 'hex');
    const tag = Buffer.from(file.tag, 'hex');
    const ciphertext = Buffer.from(file.ciphertext, 'hex');

    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
      throw new SecureStoreError('密文字段长度异常，可能已损坏', 'schema_invalid');
    }

    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new SecureStoreError(
        '密文无法解密：可能是 master key 被篡改或密文损坏',
        'decrypt_failed',
      );
    }

    try {
      const parsed = JSON.parse(plaintext.toString('utf8')) as CookieBundle;
      this.assertCookieShape(parsed);
      return parsed;
    } catch {
      throw new SecureStoreError('密文解出后不是合法 Cookie JSON', 'schema_invalid');
    }
  }

  /**
   * Cookie 是否存在（不校验合法性）。
   */
  hasCookie(): boolean {
    return fs.existsSync(this.paths.configFile) && fs.existsSync(this.paths.masterKeyFile);
  }

  /**
   * 更新最后一次成功探测的时间戳 + 账号 user_id；保留原密文，不涉及重新加密。
   */
  updateValidationMeta(meta: {
    readonly lastValidatedAt?: number;
    readonly accountUserId?: string | null;
  }): void {
    const existing = this.readConfigOrThrow();
    const next: StoredConfigFile = {
      ...existing,
      lastValidatedAt: meta.lastValidatedAt ?? existing.lastValidatedAt,
      accountUserId: meta.accountUserId ?? existing.accountUserId,
    };
    this.writeConfigAtomic(next);
  }

  /**
   * 读取元信息（不解密）—— UI 徽标 / 冷却戳场景使用。
   */
  getMeta(): Pick<StoredConfigFile, 'createdAt' | 'lastValidatedAt' | 'accountUserId'> | null {
    const existing = this.safeReadConfig();
    if (!existing) return null;
    return {
      createdAt: existing.createdAt,
      lastValidatedAt: existing.lastValidatedAt,
      accountUserId: existing.accountUserId,
    };
  }

  /**
   * 自毁：按 R18.3 顺序删除密文 → master key → SQLite → 日志。
   *
   * 使用 fs.rmSync 的 force 选项容忍「文件不存在」。
   */
  clearAll(): void {
    const targets = [
      this.paths.configFile,
      this.paths.masterKeyFile,
      this.paths.dataFile,
      this.paths.logsDir,
    ];

    for (const target of targets) {
      try {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      } catch (err) {
        logger.warn(
          { target: maskPath(target), err: (err as Error).message },
          '自毁过程中某个文件删除失败，继续处理其余文件',
        );
      }
    }

    logger.info('自毁完成：已清除 Cookie / master key / SQLite / 日志');
  }

  // ------------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------------

  private assertCookieShape(c: CookieBundle): void {
    if (!c.web_session || !c.a1 || !c.webId) {
      throw new SecureStoreError(
        'Cookie 必须至少包含 web_session / a1 / webId 三个字段',
        'schema_invalid',
      );
    }
  }

  private readMasterKeyOrThrow(): Buffer {
    if (!fs.existsSync(this.paths.masterKeyFile)) {
      throw new SecureStoreError(
        'master key 文件不存在，需要先调用 setCookie',
        'master_key_missing',
      );
    }
    return fs.readFileSync(this.paths.masterKeyFile);
  }

  private readConfigOrThrow(): StoredConfigFile {
    const existing = this.safeReadConfig();
    if (!existing) {
      throw new SecureStoreError('config.local.json 不存在，需要先导入 Cookie', 'config_missing');
    }
    return existing;
  }

  private safeReadConfig(): StoredConfigFile | null {
    if (!fs.existsSync(this.paths.configFile)) return null;
    try {
      const raw = fs.readFileSync(this.paths.configFile, 'utf8');
      const parsed = JSON.parse(raw) as StoredConfigFile;
      if (parsed.version !== 1) {
        throw new SecureStoreError(`不识别的 config 版本：${parsed.version}`, 'schema_invalid');
      }
      return parsed;
    } catch (err) {
      if (err instanceof SecureStoreError) throw err;
      throw new SecureStoreError(
        `config.local.json 解析失败：${(err as Error).message}`,
        'schema_invalid',
      );
    }
  }

  private writeConfigAtomic(file: StoredConfigFile): void {
    const projectDir = path.dirname(this.paths.configFile);
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
    }
    const tmp = `${this.paths.configFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.paths.configFile);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 日志用：把路径中的用户目录替换为 ~/，避免泄漏 macOS 下的真实路径
 * （/Users/xxx/ 可能包含真名）。
 */
function maskPath(absPath: string): string {
  const home = process.env.HOME ?? '';
  if (home && absPath.startsWith(home)) {
    return absPath.replace(home, '~');
  }
  return absPath;
}
