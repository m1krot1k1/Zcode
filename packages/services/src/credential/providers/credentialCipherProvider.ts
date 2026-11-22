import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "@zcode/shared";
import { getAppConfigDir } from "../../paths.js";

const ENCRYPTED_VALUE_PREFIX_V1 = "enc:v1:";
const ENCRYPTED_VALUE_PREFIX_V2 = "enc:v2:";
const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_MASTER_KEY_BYTES = 32;
const CREDENTIAL_SECRET_ENV_KEY = "ZCODE_CREDENTIAL_SECRET";
const CREDENTIAL_MASTER_KEY_FILE_NAME = "credential-master-key";

/** Electron safeStorage 的最小依赖面；services 包不直接 import electron。 */
export interface CredentialSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface CredentialCipherProvider {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface CredentialCipherProviderOptions {
  env?: NodeJS.ProcessEnv;
  /** Desktop main 注入；Host/CLI 进程没有时退回本地 master key。 */
  safeStorage?: CredentialSafeStorage;
  /** 测试或自定义数据目录；默认 ~/.zcode/v2/credential-master-key。 */
  masterKeyPath?: string;
}

function deriveLegacyCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function defaultLegacyCredentialSecret(env: NodeJS.ProcessEnv): string {
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY];
  if (configuredSecret) {
    return configuredSecret;
  }

  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // 部分运行环境可能拿不到系统用户，失败时退回默认占位值。
  }

  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

function base64urlToBuffer(raw: string): Buffer {
  return Buffer.from(raw, "base64url");
}

function bufferToBase64url(raw: Buffer): string {
  return raw.toString("base64url");
}

function parseMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const decoded = /^[0-9a-f]{64}$/iu.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64url");
  return decoded.length === CREDENTIAL_MASTER_KEY_BYTES ? decoded : null;
}

/**
 * 读取或创建用户目录下的 0600 master key。文件是 v2 的本地密钥材料：
 * 不写日志、不上报，权限不足时直接回退 v1，避免升级后凭据不可读。
 */
function readOrCreateMasterKey(path: string): Buffer | null {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }

  try {
    const existing = parseMasterKey(readFileSync(path, "utf-8"));
    if (existing) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Windows 或只读挂载无法调整权限；密钥仍可读。
      }
      return existing;
    }
    return null;
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      return null;
    }
  }

  const key = randomBytes(CREDENTIAL_MASTER_KEY_BYTES);
  try {
    writeFileSync(path, `${key.toString("base64url")}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      chmodSync(path, 0o600);
    } catch {
      // 见上：权限位只在 POSIX 上有意义。
    }
    return key;
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) {
      return null;
    }
    try {
      return parseMasterKey(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function createCredentialDecryptError(
  reason: string,
): Error & { code: typeof CREDENTIAL_DECRYPT_ERROR_CODE } {
  return Object.assign(new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}${reason}`), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
}

function encryptWithKey(value: string, key: Buffer, prefix: string): string {
  const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
  const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    prefix,
    bufferToBase64url(iv),
    ".",
    bufferToBase64url(authTag),
    ".",
    bufferToBase64url(encrypted),
  ].join("");
}

function decryptWithKey(value: string, prefix: string, key: Buffer): string {
  const payload = value.slice(prefix.length);
  const parts = payload.split(".");
  const [ivRaw, authTagRaw, cipherRaw] = parts;

  // Bug 根因：AES-GCM 加密空字符串时 cipherText 合法地为空，编码结果以点号结尾。
  // 旧判定把空 cipherRaw 当成缺字段，Provider Sync 为无 API Key 条目保存 journal 后
  // 就无法解密，连 before 回滚也会 fail-closed；这里只拒绝真正缺失的第三段。
  if (!ivRaw || !authTagRaw || cipherRaw === undefined || parts.length !== 3) {
    throw createCredentialDecryptError("密文格式非法");
  }

  const iv = base64urlToBuffer(ivRaw);
  const authTag = base64urlToBuffer(authTagRaw);
  const cipherText = base64urlToBuffer(cipherRaw);

  if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
    throw createCredentialDecryptError("IV 长度非法");
  }

  if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
    throw createCredentialDecryptError("AuthTag 长度非法");
  }

  const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    return plainText.toString("utf-8");
  } catch {
    throw createCredentialDecryptError("密钥不匹配或密文已损坏");
  }
}

export function createCredentialCipherProvider(
  options: CredentialCipherProviderOptions = {},
): CredentialCipherProvider {
  const env = options.env ?? process.env;
  const legacyKey = deriveLegacyCipherKey(defaultLegacyCredentialSecret(env));
  const configuredSecret = Boolean(env[CREDENTIAL_SECRET_ENV_KEY]);
  const masterKeyPath =
    options.masterKeyPath ?? join(getAppConfigDir(), CREDENTIAL_MASTER_KEY_FILE_NAME);
  // 显式 ZCODE_CREDENTIAL_SECRET 代表旧部署/测试的密钥来源，继续写 v1，避免改变既有密钥语义。
  // 其余情况优先 Electron safeStorage，再退回用户目录 master key；都不可用时仍写 v1。
  let masterKey: Buffer | null | undefined;
  const getMasterKey = (): Buffer | null => {
    if (configuredSecret) return null;
    if (masterKey !== undefined) return masterKey;
    masterKey = readOrCreateMasterKey(masterKeyPath);
    return masterKey;
  };

  return {
    encrypt(value: string): string {
      if (!configuredSecret && options.safeStorage?.isEncryptionAvailable()) {
        try {
          const encrypted = options.safeStorage.encryptString(value);
          return `${ENCRYPTED_VALUE_PREFIX_V2}s:${bufferToBase64url(encrypted)}`;
        } catch {
          // safeStorage 在 keychain 锁定时可能失败；继续尝试本地 master key。
        }
      }

      const key = getMasterKey();
      if (key) {
        return encryptWithKey(value, key, `${ENCRYPTED_VALUE_PREFIX_V2}k:`);
      }

      return encryptWithKey(value, legacyKey, ENCRYPTED_VALUE_PREFIX_V1);
    },

    decrypt(value: string): string {
      if (value.startsWith(`${ENCRYPTED_VALUE_PREFIX_V2}s:`)) {
        const encrypted = base64urlToBuffer(value.slice(`${ENCRYPTED_VALUE_PREFIX_V2}s:`.length));
        if (!options.safeStorage?.isEncryptionAvailable()) {
          throw createCredentialDecryptError("当前环境无法读取 safeStorage 凭据");
        }
        try {
          return options.safeStorage.decryptString(encrypted);
        } catch {
          throw createCredentialDecryptError("密钥不匹配或密文已损坏");
        }
      }

      if (value.startsWith(`${ENCRYPTED_VALUE_PREFIX_V2}k:`)) {
        const key = getMasterKey();
        if (!key) {
          throw createCredentialDecryptError("缺少本地凭据密钥");
        }
        return decryptWithKey(value, `${ENCRYPTED_VALUE_PREFIX_V2}k:`, key);
      }

      // enc:v1 继续用旧 homedir+username 派生密钥读取，保证升级不丢数据。
      if (value.startsWith(ENCRYPTED_VALUE_PREFIX_V1)) {
        return decryptWithKey(value, ENCRYPTED_VALUE_PREFIX_V1, legacyKey);
      }

      return value;
    },
  };
}
