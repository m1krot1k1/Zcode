import { describe, expect, it } from "vitest";
import { isSameWorkspaceTab } from "@/store/tabWorkspaceIdentity.js";

describe("isSameWorkspaceTab", () => {
  it("matches a local tab by path when no identity is requested", () => {
    expect(isSameWorkspaceTab({ workspacePath: "/a" }, "/a")).toBe(true);
    expect(isSameWorkspaceTab({ workspacePath: "/a" }, "/b")).toBe(false);
  });

  it("matches a remote tab by identity even when the path text differs", () => {
    const tab = {
      workspacePath: "/srv/app",
      workspaceIdentity: "remote:ssh:host:22:user:/srv/app",
    };

    expect(
      isSameWorkspaceTab(tab, "/srv//app/", {
        workspaceIdentity: "remote:ssh:host:22:user:/srv/app",
      }),
    ).toBe(true);
  });

  it("matches the previous identity during a reconnect", () => {
    const tab = { workspacePath: "/srv/app", workspaceIdentity: "remote:ssh:old" };

    expect(
      isSameWorkspaceTab(tab, "/srv/app", {
        workspaceIdentity: "remote:ssh:new",
        previousWorkspaceIdentity: "remote:ssh:old",
      }),
    ).toBe(true);
  });

  it("does not match a remote tab by path alone", () => {
    const tab = { workspacePath: "/srv/app", workspaceIdentity: "remote:ssh:host" };

    expect(isSameWorkspaceTab(tab, "/srv/app")).toBe(false);
  });

  it("matches by remoteSessionId when no identity is provided", () => {
    const tab = { workspacePath: "/srv/app", remoteSessionId: "session-1" };

    expect(isSameWorkspaceTab(tab, "/other", { remoteSessionId: "session-1" })).toBe(true);
    expect(isSameWorkspaceTab(tab, "/srv/app", { remoteSessionId: "session-2" })).toBe(false);
  });

  it("trims identities and does not match a local tab when an identity is requested", () => {
    const tab = { workspacePath: "/a", workspaceIdentity: " remote:ssh:host " };

    expect(isSameWorkspaceTab(tab, "/a", { workspaceIdentity: "remote:ssh:host" })).toBe(true);
    expect(
      isSameWorkspaceTab({ workspacePath: "/a" }, "/a", { workspaceIdentity: "remote:ssh:host" }),
    ).toBe(false);
  });
});
