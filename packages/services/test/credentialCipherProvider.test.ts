import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCredentialCipherProvider,
  type CredentialSafeStorage,
} from "../src/credential/providers/credentialCipherProvider.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-credential-cipher-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("credentialCipherProvider v2", () => {
  it("round-trips through a 0600 master key file", () => {
    const dir = makeTempDir();
    const masterKeyPath = join(dir, "credential-master-key");
    const cipher = createCredentialCipherProvider({ env: {}, masterKeyPath });

    const encrypted = cipher.encrypt("secret-value");
    expect(encrypted).toMatch(/^enc:v2:k:/);
    expect(encrypted).not.toContain("secret-value");
    expect(cipher.decrypt(encrypted)).toBe("secret-value");

    if (process.platform !== "win32") {
      expect(statSync(masterKeyPath).mode & 0o777).toBe(0o600);
    }

    // 新实例复用同一 key 文件，历史密文仍可读。
    const restarted = createCredentialCipherProvider({ env: {}, masterKeyPath });
    expect(restarted.decrypt(encrypted)).toBe("secret-value");
  });

  it("round-trips an empty value", () => {
    const dir = makeTempDir();
    const cipher = createCredentialCipherProvider({
      env: {},
      masterKeyPath: join(dir, "credential-master-key"),
    });

    const encrypted = cipher.encrypt("");
    expect(encrypted).toMatch(/^enc:v2:k:/);
    expect(cipher.decrypt(encrypted)).toBe("");
  });

  it("still decrypts enc:v1 values written with the legacy secret", () => {
    const dir = makeTempDir();
    const legacy = createCredentialCipherProvider({
      env: { ZCODE_CREDENTIAL_SECRET: "legacy-secret" },
      masterKeyPath: join(dir, "credential-master-key"),
    });
    const legacyValue = legacy.encrypt("old-token");
    expect(legacyValue).toMatch(/^enc:v1:/);

    const next = createCredentialCipherProvider({
      env: { ZCODE_CREDENTIAL_SECRET: "legacy-secret" },
      masterKeyPath: join(dir, "credential-master-key"),
    });
    expect(next.decrypt(legacyValue)).toBe("old-token");
  });

  it("uses Electron safeStorage when it is available", () => {
    const safeStorage: CredentialSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`safe:${value}`, "utf-8"),
      decryptString: (value) => value.toString("utf-8").slice("safe:".length),
    };
    const dir = makeTempDir();
    const cipher = createCredentialCipherProvider({
      env: {},
      masterKeyPath: join(dir, "credential-master-key"),
      safeStorage,
    });

    const encrypted = cipher.encrypt("keychain-secret");
    expect(encrypted).toMatch(/^enc:v2:s:/);
    expect(cipher.decrypt(encrypted)).toBe("keychain-secret");
  });

  it("fails closed when safeStorage ciphertext is read without safeStorage", () => {
    const safeStorage: CredentialSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`safe:${value}`, "utf-8"),
      decryptString: (value) => value.toString("utf-8").slice("safe:".length),
    };
    const dir = makeTempDir();
    const masterKeyPath = join(dir, "credential-master-key");
    const encrypted = createCredentialCipherProvider({
      env: {},
      masterKeyPath,
      safeStorage,
    }).encrypt("keychain-secret");

    const withoutSafeStorage = createCredentialCipherProvider({ env: {}, masterKeyPath });
    expect(() => withoutSafeStorage.decrypt(encrypted)).toThrow(/safeStorage/);
  });
});
