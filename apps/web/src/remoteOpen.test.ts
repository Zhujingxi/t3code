import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { buildRemoteOpenUrl, EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { openRemoteEditorUrl, resolveRemoteOpenState } from "./remoteOpen";

afterEach(() => vi.unstubAllGlobals());

describe("openRemoteEditorUrl", () => {
  const url = "vscode://vscode-remote/ssh-remote+server/work/project";

  it("keeps an embedded workspace in place while launching the editor", async () => {
    const assign = vi.fn();
    const open = vi.fn().mockReturnValue(null);
    vi.stubGlobal("window", { self: {}, top: {}, location: { assign }, open });

    expect(await openRemoteEditorUrl(url)).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith(url, "_blank", "noopener,noreferrer");
    expect(assign).not.toHaveBeenCalled();
  });

  it("uses the current location in a standalone browser", async () => {
    const context = {};
    const assign = vi.fn();
    const open = vi.fn();
    vi.stubGlobal("window", { self: context, top: context, location: { assign }, open });

    expect(await openRemoteEditorUrl(url)).toBe(true);
    expect(assign).toHaveBeenCalledExactlyOnceWith(url);
    expect(open).not.toHaveBeenCalled();
  });

  it("uses the desktop shell instead of browser navigation", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { desktopBridge: { openExternal } });

    expect(await openRemoteEditorUrl(url)).toBe(true);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("preserves a desktop shell rejection", async () => {
    vi.stubGlobal("window", { desktopBridge: { openExternal: vi.fn().mockResolvedValue(false) } });
    expect(await openRemoteEditorUrl(url)).toBe(false);
  });

  it("reports a desktop shell failure", async () => {
    vi.stubGlobal("window", {
      desktopBridge: { openExternal: vi.fn().mockRejectedValue(new Error("Launch failed")) },
    });
    expect(await openRemoteEditorUrl(url)).toBe(false);
  });
});

const environmentId = EnvironmentId.make("environment-1");

const primaryTarget = (httpBaseUrl: string) =>
  new PrimaryConnectionTarget({
    environmentId,
    label: "sol",
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace("http", "ws"),
  });

const TAILSCALE_TARGETS = [
  { kind: "tailscale", host: "sol.tail1234.ts.net" },
  { kind: "mdns", host: "sol.local" },
] as const;

describe("resolveRemoteOpenState", () => {
  it("keeps exec behavior for a loopback primary target", () => {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("http://127.0.0.1:8000"),
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("uses deep links for a primary target reached over the network", () => {
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("https://sol.tail1234.ts.net"),
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({
      mode: "remote-links",
      host: { kind: "tailscale", host: "sol.tail1234.ts.net" },
    });
  });

  it("keeps exec behavior for the desktop app's own primary even on a NAT URL", () => {
    // wsl-only mode binds the primary to the WSL2 NAT address; it is still
    // this machine because the desktop app manages its own primary backend.
    expect(
      resolveRemoteOpenState({
        target: primaryTarget("http://172.29.112.1:14369"),
        sshAlias: null,
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("keeps exec behavior for desktop-local secondary backends", () => {
    expect(
      resolveRemoteOpenState({
        target: new BearerConnectionTarget({
          environmentId,
          label: "WSL (Ubuntu)",
          connectionId: "local:wsl-1",
        }),
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "local-exec" });
  });

  it("prefers the desktop SSH alias over server-advertised hosts", () => {
    expect(
      resolveRemoteOpenState({
        target: new SshConnectionTarget({
          environmentId,
          label: "sol",
          connectionId: "ssh-1",
        }),
        sshAlias: "sol",
        isDesktopRenderer: true,
        remoteOpenTargets: TAILSCALE_TARGETS,
      }),
    ).toEqual({ mode: "remote-links", host: { kind: "ssh-alias", host: "sol" } });
  });

  it("reports unavailable when a remote environment advertises no hosts", () => {
    for (const remoteOpenTargets of [[], undefined] as const) {
      expect(
        resolveRemoteOpenState({
          target: new RelayConnectionTarget({ environmentId, label: "sol" }),
          sshAlias: null,
          isDesktopRenderer: false,
          remoteOpenTargets,
        }),
      ).toEqual({ mode: "remote-unavailable" });
    }
  });

  it("falls back to exec when the environment has no catalog entry", () => {
    expect(
      resolveRemoteOpenState({
        target: null,
        sshAlias: null,
        isDesktopRenderer: false,
        remoteOpenTargets: undefined,
      }),
    ).toEqual({ mode: "local-exec" });
  });
});

describe("buildRemoteOpenUrl", () => {
  it("builds a vscode-remote deep link", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "vscode",
        host: "sol.tail1234.ts.net",
        absolutePath: "/home/theo/code/my repo",
      }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol.tail1234.ts.net/home/theo/code/my%20repo");
  });

  it("uses the fork's scheme", () => {
    expect(buildRemoteOpenUrl({ editor: "cursor", host: "sol", absolutePath: "/tmp/x" })).toBe(
      "cursor://vscode-remote/ssh-remote+sol/tmp/x",
    );
  });

  it("roots Windows paths", () => {
    expect(
      buildRemoteOpenUrl({ editor: "vscode", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe("vscode://vscode-remote/ssh-remote+sol/C%3A/Users/theo");
  });

  it("builds Zed's ssh deep link", () => {
    expect(
      buildRemoteOpenUrl({
        editor: "zed",
        host: "sol.tail1234.ts.net",
        absolutePath: "/home/theo/code/my repo",
      }),
    ).toBe("zed://ssh/sol.tail1234.ts.net/home/theo/code/my%20repo");
  });

  it("drops the Windows drive letter for Zed", () => {
    expect(
      buildRemoteOpenUrl({ editor: "zed", host: "sol", absolutePath: "C:\\Users\\theo" }),
    ).toBe("zed://ssh/sol/Users/theo");
    expect(buildRemoteOpenUrl({ editor: "zed", host: "sol", absolutePath: "/C:/project" })).toBe(
      "zed://ssh/sol/C%3A/project",
    );
  });

  it("returns undefined for editors without remote support", () => {
    expect(buildRemoteOpenUrl({ editor: "idea", host: "sol", absolutePath: "/tmp/x" })).toBe(
      undefined,
    );
  });
});
