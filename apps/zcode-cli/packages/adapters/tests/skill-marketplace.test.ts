import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeSkillAdapter } from "../src/skills/index.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-skill-marketplace-"));
  tempDirs.push(dir);
  return dir;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("skills.sh marketplace adapter", () => {
  it("searches, sorts by installs, limits results, and marks installed skills", async () => {
    const workspace = await makeWorkspace();
    await mkdir(join(workspace, ".agents", "skills", "react-best-practices"), { recursive: true });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        skills: [
          { id: "owner/repo/low", source: "owner/repo", skillId: "low", name: "Low", installs: 5 },
          {
            id: "owner/repo/high",
            source: "owner/repo",
            skillId: "high",
            name: "High",
            installs: 500,
          },
          {
            id: "owner/repo/react-best-practices",
            source: "owner/repo",
            skillId: "react-best-practices",
            name: "React",
            installs: 100,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createNodeSkillAdapter({ homeDirectory: join(workspace, "home") });

    const result = await adapter.searchMarketplace({
      query: "react",
      workingDirectory: workspace,
      limit: 2,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/search?q=react");
    expect(result.items.map((item) => item.skillId)).toEqual(["high", "react-best-practices"]);
    expect(result.items[1]?.installed).toBe(true);
  });

  it("installs a snapshot and makes it loadable immediately", async () => {
    const workspace = await makeWorkspace();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        hash: "hash-1",
        files: [
          {
            path: "SKILL.md",
            contents: "---\nname: find-skills\ndescription: Find skills.\n---\n\nUse it.\n",
          },
          { path: "references/example.md", contents: "Example\n" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createNodeSkillAdapter({ homeDirectory: join(workspace, "home") });

    const result = await adapter.installMarketplaceSkill({
      source: "vercel-labs/skills",
      skillId: "find-skills",
      workingDirectory: workspace,
    });

    expect(result).toMatchObject({
      name: "find-skills",
      source: "vercel-labs/skills",
      skillId: "find-skills",
      filesWritten: 3,
      alreadyInstalled: false,
    });
    expect(
      await readFile(join(workspace, ".agents", "skills", "find-skills", "SKILL.md"), "utf8"),
    ).toContain("name: find-skills");
    const metadata = JSON.parse(
      await readFile(
        join(workspace, ".agents", "skills", "find-skills", "_meta.json"),
        "utf8",
      ),
    ) as { source: string; hash: string };
    expect(metadata).toMatchObject({ source: "vercel-labs/skills", hash: "hash-1" });

    const loaded = await adapter.loadSkill({ name: "find-skills", workingDirectory: workspace });
    expect(loaded.content).toContain("Use it.");
    expect(loaded.baseDirectory).toBe(join(workspace, ".agents", "skills", "find-skills"));
  });

  it("rejects path traversal and snapshots without a root SKILL.md", async () => {
    const workspace = await makeWorkspace();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ files: [{ path: "../escape.md", contents: "no" }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ files: [{ path: "references/example.md", contents: "no" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createNodeSkillAdapter({ homeDirectory: join(workspace, "home") });

    await expect(
      adapter.installMarketplaceSkill({
        source: "owner/repo",
        skillId: "unsafe",
        workingDirectory: workspace,
      }),
    ).rejects.toThrow("path traversal");
    await expect(
      adapter.installMarketplaceSkill({
        source: "owner/repo",
        skillId: "missing-skill",
        workingDirectory: workspace,
      }),
    ).rejects.toThrow("must contain SKILL.md");
  });

  it("does not overwrite a hand-written skill even when overwrite is requested", async () => {
    const workspace = await makeWorkspace();
    const skillDir = join(workspace, ".agents", "skills", "hand-written");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: hand-written\ndescription: Local.\n---\n\nLocal.\n",
      "utf8",
    );
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        files: [
          {
            path: "SKILL.md",
            contents: "---\nname: hand-written\ndescription: Remote.\n---\n\nRemote.\n",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createNodeSkillAdapter({ homeDirectory: join(workspace, "home") });

    await expect(
      adapter.installMarketplaceSkill({
        source: "owner/repo",
        skillId: "hand-written",
        workingDirectory: workspace,
        overwrite: true,
      }),
    ).rejects.toThrow("refusing to overwrite non-marketplace skill");
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("Local.");
  });
});
