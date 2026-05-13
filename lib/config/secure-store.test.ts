/**
 * SecureStore 单元测试
 *
 * 验证：
 *   - 密钥文件与密文文件物理分离（R4.2）
 *   - 读写对称：加密 → 解密严格相等
 *   - 日志脱敏：Cookie 字符串不得在 pino 输出中出现原文（R4.3 / R20.2）
 *   - 防篡改：master key 被换掉 → 解密失败（认证保证）
 *   - clearAll 顺序删除所有敏感文件（R18.3）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maskSecret } from './logger';
import { SecureStore, SecureStoreError } from './secure-store';

let tmpHome: string;
let tmpProject: string;
let store: SecureStore;

const SAMPLE_COOKIE = {
  web_session: 'web_session_abcdefg_1234567890_realistic_length',
  a1: 'a1_fingerprint_xyz_9876543210',
  webId: 'webid_unique_device_id_001',
};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-sec-home-'));
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-sec-proj-'));
  store = new SecureStore({ homeDir: tmpHome, projectDir: tmpProject });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpProject, { recursive: true, force: true });
});

describe('SecureStore — 基础读写', () => {
  it('未写入时 hasCookie 返回 false', () => {
    expect(store.hasCookie()).toBe(false);
  });

  it('setCookie + getCookie 读写对称（严格相等）', () => {
    store.setCookie(SAMPLE_COOKIE);
    const retrieved = store.getCookie();
    expect(retrieved).toEqual(SAMPLE_COOKIE);
  });

  it('写入后 hasCookie 返回 true 且 master key 已生成', () => {
    store.setCookie(SAMPLE_COOKIE);
    expect(store.hasCookie()).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, 'master.key'))).toBe(true);
    expect(fs.existsSync(path.join(tmpProject, 'config.local.json'))).toBe(true);
  });

  it('未先 setCookie 就调用 getCookie 抛 config_missing', () => {
    try {
      store.getCookie();
      expect.fail('应该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(SecureStoreError);
      expect((err as SecureStoreError).code).toBe('config_missing');
    }
  });
});

describe('SecureStore — 物理分离（R4.2）', () => {
  it('master key 文件与 config.local.json 不在同一目录', () => {
    store.setCookie(SAMPLE_COOKIE);
    const keyFile = path.join(tmpHome, 'master.key');
    const cipherFile = path.join(tmpProject, 'config.local.json');
    expect(path.dirname(keyFile)).not.toBe(path.dirname(cipherFile));
    expect(tmpHome).not.toBe(tmpProject);
  });

  it('config.local.json 中不包含 Cookie 原文（加密后已混淆）', () => {
    store.setCookie(SAMPLE_COOKIE);
    const raw = fs.readFileSync(path.join(tmpProject, 'config.local.json'), 'utf8');
    expect(raw).not.toContain(SAMPLE_COOKIE.web_session);
    expect(raw).not.toContain(SAMPLE_COOKIE.a1);
    expect(raw).not.toContain(SAMPLE_COOKIE.webId);
  });

  it('master key 文件权限为 0600（仅所有者可读写）', () => {
    store.setCookie(SAMPLE_COOKIE);
    const stat = fs.statSync(path.join(tmpHome, 'master.key'));
    const mode = stat.mode & 0o777;
    // 类 Unix 系统期望是 0600；Windows 上 mode 不可靠，放宽到 <= 0o600
    expect(mode).toBeLessThanOrEqual(0o600);
  });
});

describe('SecureStore — 认证加密防篡改', () => {
  it('替换 master key 后解密失败（GCM 认证失败）', () => {
    store.setCookie(SAMPLE_COOKIE);
    // 替换 master key 为全零
    const keyFile = path.join(tmpHome, 'master.key');
    fs.writeFileSync(keyFile, Buffer.alloc(32));

    try {
      store.getCookie();
      expect.fail('应该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(SecureStoreError);
      expect((err as SecureStoreError).code).toBe('decrypt_failed');
    }
  });

  it('篡改 ciphertext 一个字节后解密失败', () => {
    store.setCookie(SAMPLE_COOKIE);
    const cipherFile = path.join(tmpProject, 'config.local.json');
    const file = JSON.parse(fs.readFileSync(cipherFile, 'utf8'));
    // 改掉首字符
    const tampered = `00${file.ciphertext.slice(2)}`;
    fs.writeFileSync(cipherFile, JSON.stringify({ ...file, ciphertext: tampered }));

    try {
      store.getCookie();
      expect.fail('应该抛错');
    } catch (err) {
      expect((err as SecureStoreError).code).toBe('decrypt_failed');
    }
  });
});

describe('SecureStore — IV 唯一性（GCM 必须）', () => {
  it('两次写入使用不同的 IV', () => {
    store.setCookie(SAMPLE_COOKIE);
    const first = JSON.parse(
      fs.readFileSync(path.join(tmpProject, 'config.local.json'), 'utf8'),
    ) as { iv: string };

    store.setCookie({ ...SAMPLE_COOKIE, web_session: 'rotated_session' });
    const second = JSON.parse(
      fs.readFileSync(path.join(tmpProject, 'config.local.json'), 'utf8'),
    ) as { iv: string };

    expect(first.iv).not.toBe(second.iv);
  });
});

describe('SecureStore — Cookie 字段校验', () => {
  it('缺字段时抛 schema_invalid', () => {
    expect(() => store.setCookie({ web_session: 'x', a1: '', webId: 'y' } as never)).toThrow(
      SecureStoreError,
    );
  });
});

describe('SecureStore — updateValidationMeta', () => {
  it('保留密文，只更新 lastValidatedAt / accountUserId', () => {
    store.setCookie(SAMPLE_COOKIE);
    const before = fs.readFileSync(path.join(tmpProject, 'config.local.json'), 'utf8');
    const beforeJson = JSON.parse(before) as { ciphertext: string };

    store.updateValidationMeta({
      lastValidatedAt: 1_700_000_000_000,
      accountUserId: 'me_user_001',
    });

    const afterJson = JSON.parse(
      fs.readFileSync(path.join(tmpProject, 'config.local.json'), 'utf8'),
    ) as { ciphertext: string };

    // 密文不变
    expect(afterJson.ciphertext).toBe(beforeJson.ciphertext);

    const meta = store.getMeta();
    expect(meta?.lastValidatedAt).toBe(1_700_000_000_000);
    expect(meta?.accountUserId).toBe('me_user_001');
  });
});

describe('SecureStore — clearAll 自毁', () => {
  it('顺序删除 master key / 密文 / SQLite / 日志目录', () => {
    store.setCookie(SAMPLE_COOKIE);
    // 手动建两个「伴生文件」模拟真实环境
    fs.writeFileSync(path.join(tmpProject, 'data.db'), 'SQLITE');
    fs.mkdirSync(path.join(tmpProject, '.logs'), { recursive: true });
    fs.writeFileSync(path.join(tmpProject, '.logs', 'app.log'), 'some log');

    store.clearAll();

    expect(fs.existsSync(path.join(tmpHome, 'master.key'))).toBe(false);
    expect(fs.existsSync(path.join(tmpProject, 'config.local.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpProject, 'data.db'))).toBe(false);
    expect(fs.existsSync(path.join(tmpProject, '.logs'))).toBe(false);
  });

  it('clearAll 在没有任何文件的初始状态下也不抛错', () => {
    expect(() => store.clearAll()).not.toThrow();
  });
});

// ============================================================================
// 日志脱敏（R4.3 / R20.2）
// ============================================================================

describe('Logger — Cookie 脱敏', () => {
  it('maskSecret 把长字符串处理成 xxxx**** 形式', () => {
    const masked = maskSecret(SAMPLE_COOKIE.web_session);
    expect(masked).toMatch(/^web_\*+$/);
    expect(masked).not.toContain(SAMPLE_COOKIE.web_session);
  });

  it('maskSecret 对短字符串全打星', () => {
    expect(maskSecret('ab')).toBe('**');
  });

  it('SecureStore.setCookie 的 pino 日志不得出现 web_session 原文', async () => {
    // 截获 stderr（pino 默认输出到 stderr）
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });

    try {
      store.setCookie(SAMPLE_COOKIE);
    } finally {
      spy.mockRestore();
      spyErr.mockRestore();
    }

    const allLogs = chunks.join('');
    // 原则：日志里绝不能出现任何 Cookie 字段的原文
    expect(allLogs).not.toContain(SAMPLE_COOKIE.web_session);
    expect(allLogs).not.toContain(SAMPLE_COOKIE.a1);
    expect(allLogs).not.toContain(SAMPLE_COOKIE.webId);
  });
});
