import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ISkillsService } from "../src/skills/skills.js";

const originalHome = process.env.HOME;
let workspacePath: string;
let homePath: string;

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installPayload(files: Array<{ path: string; contents: string }>, hash?: string) {
  return { files, ...(hash ? { hash } : {}) };
}

async function createService(): Promise<ISkillsService> {
  process.env.HOME = homePath;
  vi.resetModules();
  const mod = await import("../src/skills/skillsService.js");
  return mod.createSkillsService({ isDesktopRuntime: true });
}

async function expectMarketplaceError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "SkillMarketplaceError", code });
}

beforeEach(() => {
  workspacePath = makeTempDir("zcode-marketplace-workspace-");
  homePath = makeTempDir("zcode-marketplace-home-");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe("skills marketplace", () => {
  it("空 query 返回空数组且不发起网络请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = await createService();

    const result = await service.searchMarketplace("   ", { workspacePath });

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("搜索映射 MarketplaceSkillInfo 并按本地技能目录标记 installed", async () => {
    const skillDir = join(workspacePath, ".agents", "skills", "yandex-wordstat");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: yandex-wordstat\ndescription: Wordstat\n---\n",
      "utf8",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        query: "yandex",
        skills: [
          {
            id: "artwist-polyakov/polyakov-claude-skills/yandex-wordstat",
            source: "artwist-polyakov/polyakov-claude-skills",
            skillId: "yandex-wordstat",
            name: "yandex-wordstat",
            installs: 309,
          },
          {
            id: "elsvv/yandex-direct-skill/yandex-direct",
            source: "elsvv/yandex-direct-skill",
            skillId: "yandex-direct",
            name: "yandex-direct",
            installs: 114,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = await createService();

    const result = await service.searchMarketplace("yandex", { workspacePath });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("https://skills.sh/api/search?q=yandex");
    expect(result).toEqual([
      {
        name: "yandex-wordstat",
        skillId: "yandex-wordstat",
        source: "artwist-polyakov/polyakov-claude-skills",
        installs: 309,
        installed: true,
      },
      {
        name: "yandex-direct",
        skillId: "yandex-direct",
        source: "elsvv/yandex-direct-skill",
        installs: 114,
        installed: false,
      },
    ]);
  });

  it("unknown or invalid installs stay absent instead of becoming zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          skills: [
            {
              source: "acme/skills",
              skillId: "missing-count",
              name: "missing-count",
            },
            {
              source: "acme/skills",
              skillId: "string-count",
              name: "string-count",
              installs: "100",
            },
            {
              source: "acme/skills",
              skillId: "negative-count",
              name: "negative-count",
              installs: -1,
            },
            {
              source: "acme/skills",
              skillId: "known-zero",
              name: "known-zero",
              installs: 0,
            },
          ],
        }),
      ),
    );
    const service = await createService();

    const result = await service.searchMarketplace("skills", { workspacePath });

    expect(result).toEqual([
      {
        name: "missing-count",
        skillId: "missing-count",
        source: "acme/skills",
        installed: false,
      },
      {
        name: "string-count",
        skillId: "string-count",
        source: "acme/skills",
        installed: false,
      },
      {
        name: "negative-count",
        skillId: "negative-count",
        source: "acme/skills",
        installed: false,
      },
      {
        name: "known-zero",
        skillId: "known-zero",
        source: "acme/skills",
        installs: 0,
        installed: false,
      },
    ]);
    expect(Object.hasOwn(result[0]!, "installs")).toBe(false);
    expect(Object.hasOwn(result[3]!, "installs")).toBe(true);
  });

  it("orders missing installs after a measured zero when resolving a bare skill name", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          skills: [
            {
              source: "unknown/skill-repo",
              skillId: "same-skill",
              name: "same-skill",
            },
            {
              source: "known/skill-repo",
              skillId: "same-skill",
              name: "same-skill",
              installs: 0,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          files: [
            {
              path: "SKILL.md",
              contents: "---\nname: same-skill\ndescription: Demo\n---\n",
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const service = await createService();

    await service.installMarketplaceSkill({
      name: "same-skill",
      scope: "workspace",
      workspacePath,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "https://skills.sh/api/download/known/skill-repo/same-skill",
    );
  });

  it("搜索空结果返回空数组", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ skills: [] })));
    const service = await createService();
    await expect(service.searchMarketplace("nothing", { workspacePath })).resolves.toEqual([]);
  });

  it("搜索非 200 返回 http_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));
    const service = await createService();
    await expectMarketplaceError(service.searchMarketplace("yandex"), "http_error");
  });

  it("搜索网络错误返回 network", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const service = await createService();
    await expectMarketplaceError(service.searchMarketplace("yandex"), "network");
  });

  it("搜索返回非 JSON 时返回 invalid_response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    const service = await createService();
    await expectMarketplaceError(service.searchMarketplace("yandex"), "invalid_response");
  });

  it("安装 happy path：写入文件与 _meta.json，返回实际名称且不执行下载脚本", async () => {
    const marker = join(workspacePath, "EXECUTED");
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        installPayload(
          [
            {
              path: "SKILL.md",
              contents:
                "---\nname: yandex-direct\ndescription: Yandex Direct API\nversion: 1.2.3\n---\n\n# Direct\n",
            },
            {
              path: "scripts/get_token.sh",
              contents: `#!/bin/sh\ntouch "${marker}"\n`,
            },
            { path: "config/.env.example", contents: "TOKEN=\n" },
          ],
          "remote-hash-1",
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = await createService();

    const result = await service.installMarketplaceSkill({
      name: "elsvv/yandex-direct-skill/yandex-direct",
      scope: "workspace",
      workspacePath,
    });

    const target = join(workspacePath, ".agents", "skills", "yandex-direct");
    expect(result).toEqual({ name: "yandex-direct", scope: "workspace", path: target });
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("Yandex Direct API");
    expect(readFileSync(join(target, "scripts", "get_token.sh"), "utf8")).toContain("touch");
    expect(readFileSync(join(target, "config", ".env.example"), "utf8")).toBe("TOKEN=\n");
    expect(existsSync(marker)).toBe(false);

    const meta = JSON.parse(readFileSync(join(target, "_meta.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(meta.source).toBe("elsvv/yandex-direct-skill");
    expect(meta.skillId).toBe("yandex-direct");
    expect(meta.name).toBe("yandex-direct");
    expect(meta.scope).toBe("workspace");
    expect(meta.version).toBe("1.2.3");
    expect(meta.remoteHash).toBe("remote-hash-1");
    expect(meta.manager).toBe("skills.sh");
    expect(String(meta.hash)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Number.isNaN(Date.parse(String(meta.installedAt)))).toBe(false);
  });

  it("兼容 files 对象映射与 content 字段", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          files: {
            "SKILL.md": "---\nname: mapped-skill\n---\n",
            "references/notes.md": "notes",
          },
        }),
      ),
    );
    const service = await createService();

    const result = await service.installMarketplaceSkill({
      name: "a/b/mapped-skill",
      scope: "workspace",
      workspacePath,
    });

    const target = join(workspacePath, ".agents", "skills", "mapped-skill");
    expect(result.name).toBe("mapped-skill");
    expect(readFileSync(join(target, "references", "notes.md"), "utf8")).toBe("notes");
  });

  it("裸 skillId 先搜索解析来源再下载", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          skills: [
            {
              source: "elsvv/yandex-direct-skill",
              skillId: "yandex-direct",
              name: "yandex-direct",
              installs: 114,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(installPayload([{ path: "SKILL.md", contents: "---\nname: yandex-direct\n---\n" }])),
      );
    vi.stubGlobal("fetch", fetchMock);
    const service = await createService();

    const result = await service.installMarketplaceSkill({
      name: "yandex-direct",
      scope: "workspace",
      workspacePath,
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/search?q=yandex-direct");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://skills.sh/api/download/elsvv/yandex-direct-skill/yandex-direct",
    );
    expect(result.name).toBe("yandex-direct");
  });

  it("拒绝路径穿越且不留下目标目录", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          installPayload([
            { path: "SKILL.md", contents: "---\nname: evil\n---\n" },
            { path: "../evil.txt", contents: "pwned" },
          ]),
        ),
      ),
    );
    const service = await createService();

    await expectMarketplaceError(
      service.installMarketplaceSkill({ name: "a/b/evil", scope: "workspace", workspacePath }),
      "unsafe_snapshot",
    );
    expect(existsSync(join(workspacePath, ".agents", "skills", "evil"))).toBe(false);
    expect(existsSync(join(workspacePath, ".agents", "skills", "evil.txt"))).toBe(false);
    expect(existsSync(join(workspacePath, "evil.txt"))).toBe(false);
  });

  it("拒绝绝对路径与 Windows drive-letter 路径", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          installPayload([
            { path: "SKILL.md", contents: "---\nname: evil\n---\n" },
            { path: "/tmp/evil.txt", contents: "pwned" },
          ]),
        ),
      ),
    );
    const service = await createService();
    await expectMarketplaceError(
      service.installMarketplaceSkill({ name: "a/b/evil", scope: "workspace", workspacePath }),
      "unsafe_snapshot",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          installPayload([
            { path: "SKILL.md", contents: "---\nname: evil\n---\n" },
            { path: "C:\\Windows\\evil.txt", contents: "pwned" },
          ]),
        ),
      ),
    );
    const service2 = await createService();
    await expectMarketplaceError(
      service2.installMarketplaceSkill({
        name: "a/b/evil2",
        scope: "workspace",
        workspacePath,
      }),
      "unsafe_snapshot",
    );
  });

  it("超过单文件 5 MiB 限制时拒绝", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          installPayload([
            { path: "SKILL.md", contents: "---\nname: big\n---\n" },
            { path: "big.bin", contents: "x".repeat(5 * 1024 * 1024 + 1) },
          ]),
        ),
      ),
    );
    const service = await createService();
    await expectMarketplaceError(
      service.installMarketplaceSkill({ name: "a/b/big", scope: "workspace", workspacePath }),
      "limit_exceeded",
    );
  });

  it("超过总计 10 MiB 限制时拒绝", async () => {
    const chunk = "x".repeat(4 * 1024 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          installPayload([
            { path: "SKILL.md", contents: "---\nname: big\n---\n" },
            { path: "a.txt", contents: chunk },
            { path: "b.txt", contents: chunk },
            { path: "c.txt", contents: chunk },
          ]),
        ),
      ),
    );
    const service = await createService();
    await expectMarketplaceError(
      service.installMarketplaceSkill({ name: "a/b/big", scope: "workspace", workspacePath }),
      "limit_exceeded",
    );
  });

  it("超过 500 文件限制时拒绝", async () => {
    const files = Array.from({ length: 500 }, (_, index) => ({
      path: `references/file-${index}.md`,
      contents: "x",
    }));
    files.unshift({ path: "SKILL.md", contents: "---\nname: many\n---\n" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(installPayload(files))));
    const service = await createService();
    await expectMarketplaceError(
      service.installMarketplaceSkill({ name: "a/b/many", scope: "workspace", workspacePath }),
      "limit_exceeded",
    );
  });

  it("缺少根 SKILL.md 时拒绝", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(installPayload([{ path: "docs/SKILL.md", contents: "---\nname: x\n---\n" }])),
      ),
    );
    const service = await createService();
    await expectMarketplaceError(
      service.installMarketplaceSkill({ name: "a/b/noskill", scope: "workspace", workspacePath }),
      "unsafe_snapshot",
    );
  });

  it("user scope 写入 ~/.agents/skills", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(installPayload([{ path: "SKILL.md", contents: "---\nname: yandex-metrica\n---\n" }])),
      ),
    );
    const service = await createService();

    const result = await service.installMarketplaceSkill({
      name: "elsvv/yandex-metrica-skill/yandex-metrica",
      scope: "user",
    });

    const target = join(homePath, ".agents", "skills", "yandex-metrica");
    expect(result).toEqual({ name: "yandex-metrica", scope: "user", path: target });
    expect(existsSync(join(target, "SKILL.md"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(target, "_meta.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(meta.scope).toBe("user");
  });

  it("拒绝覆盖 hand-written 同名技能", async () => {
    const target = join(workspacePath, ".agents", "skills", "yandex-direct");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "hand written", "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(installPayload([{ path: "SKILL.md", contents: "---\nname: yandex-direct\n---\n" }])),
      ),
    );
    const service = await createService();

    await expectMarketplaceError(
      service.installMarketplaceSkill({
        name: "elsvv/yandex-direct-skill/yandex-direct",
        scope: "workspace",
        workspacePath,
      }),
      "write_conflict",
    );
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("hand written");
  });

  it("重复安装同一 marketplace 技能是幂等的并可更新内容", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(installPayload([{ path: "SKILL.md", contents: "---\nname: yandex-direct\n---\nv1\n" }])),
      )
      .mockResolvedValueOnce(
        jsonResponse(installPayload([{ path: "SKILL.md", contents: "---\nname: yandex-direct\n---\nv2\n" }])),
      );
    vi.stubGlobal("fetch", fetchMock);
    const service = await createService();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await service.installMarketplaceSkill({
        name: "elsvv/yandex-direct-skill/yandex-direct",
        scope: "workspace",
        workspacePath,
      });
    }

    const target = join(workspacePath, ".agents", "skills", "yandex-direct");
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("v2");
    expect(existsSync(join(workspacePath, ".agents", "skills", ".tmp-marketplace-x"))).toBe(false);
  });

  it("workspace scope 缺少 workspacePath 时返回 invalid_input 且不触网", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = await createService();
    await expectMarketplaceError(
      service.installMarketplaceSkill({ name: "a/b/c", scope: "workspace" }),
      "invalid_input",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("安装返回非 200 时保留 http_error 且不写目录", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    const service = await createService();
    await expectMarketplaceError(
      service.installMarketplaceSkill({ name: "a/b/c", scope: "workspace", workspacePath }),
      "http_error",
    );
    expect(existsSync(join(workspacePath, ".agents", "skills", "c"))).toBe(false);
  });
});
