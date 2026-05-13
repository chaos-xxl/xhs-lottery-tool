/**
 * 统一管理所有本地敏感文件的路径。
 *
 * 设计约束：
 *   - 密钥（master.key）与密文（config.local.json）物理分离（R4.2）
 *   - 密钥落在 ~/.kiro/xhs-lottery/ 下，密文落在项目根目录（data.db 同级）
 *   - 测试通过 XHS_LOTTERY_HOME 环境变量覆盖，避免污染真实 $HOME
 */

import os from 'node:os';
import path from 'node:path';

export interface LocalPaths {
  /** 主密钥文件（与密文分离） */
  readonly masterKeyFile: string;
  /** 加密后的 Cookie 配置文件 */
  readonly configFile: string;
  /** SQLite 数据文件 */
  readonly dataFile: string;
  /** 日志目录 */
  readonly logsDir: string;
  /** 用户本地根（master key + 相关密钥的所在目录） */
  readonly homeDir: string;
  /** 项目根（config.local.json / data.db 所在） */
  readonly projectDir: string;
}

/**
 * 解析所有路径。允许通过环境变量覆盖（测试使用）：
 *   - XHS_LOTTERY_HOME：替代 ~/.kiro/xhs-lottery
 *   - XHS_LOTTERY_PROJECT_DIR：替代项目根（默认 process.cwd()）
 */
export function resolveLocalPaths(
  overrides: { homeDir?: string; projectDir?: string } = {},
): LocalPaths {
  const envHome = process.env.XHS_LOTTERY_HOME;
  const envProject = process.env.XHS_LOTTERY_PROJECT_DIR;

  const homeDir = overrides.homeDir ?? envHome ?? path.join(os.homedir(), '.kiro', 'xhs-lottery');
  const projectDir = overrides.projectDir ?? envProject ?? process.cwd();

  return {
    homeDir,
    projectDir,
    masterKeyFile: path.join(homeDir, 'master.key'),
    configFile: path.join(projectDir, 'config.local.json'),
    dataFile: path.join(projectDir, 'data.db'),
    logsDir: path.join(projectDir, '.logs'),
  };
}
