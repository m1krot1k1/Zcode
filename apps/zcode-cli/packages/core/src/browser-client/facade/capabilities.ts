import type { BrowserCommand } from "@zcode/contracts/browser-control";
import { expectOk } from "../result.js";
import type { BrowserAvailabilityGuard, BrowserCapabilityInfo, BrowserExecuteFn } from "./types.js";

export class BrowserCapability {
  readonly #readDocumentation: (name?: string) => string;

  constructor(
    readonly id: string,
    readonly description: string,
    readDocumentation: (name?: string) => string,
  ) {
    this.#readDocumentation = readDocumentation;
  }

  async documentation(): Promise<string> {
    return this.#readDocumentation(this.id);
  }
}

class VisibilityBrowserCapability extends BrowserCapability {
  constructor(
    info: BrowserCapabilityInfo,
    readDocumentation: (name?: string) => string,
    private readonly execute: BrowserExecuteFn,
  ) {
    super(info.id, info.description, readDocumentation);
  }

  async get(): Promise<boolean> {
    const command: BrowserCommand = { method: "browserVisibilityGet" };
    const result = expectOk(command, await this.execute(command));
    if (typeof result.value !== "boolean") {
      throw new Error("Browser visibility result is missing a boolean value");
    }
    return result.value;
  }

  async set(visible: boolean): Promise<void> {
    if (typeof visible !== "boolean") throw new TypeError("visibility.set requires a boolean");
    const command: BrowserCommand = { method: "browserVisibilitySet", visible };
    expectOk(command, await this.execute(command));
  }
}

export class BrowserCapabilityCollection {
  readonly #read: () => readonly BrowserCapabilityInfo[];
  readonly #readDocumentation: (name?: string) => string;

  constructor(
    read: () => readonly BrowserCapabilityInfo[],
    readDocumentation: (name?: string) => string,
    private readonly execute?: BrowserExecuteFn,
    private readonly assertAvailable: BrowserAvailabilityGuard = () => undefined,
  ) {
    this.#read = read;
    this.#readDocumentation = readDocumentation;
  }

  async list(): Promise<BrowserCapabilityInfo[]> {
    this.assertAvailable();
    return this.#read().map((capability) => ({ ...capability }));
  }

  get(id: "visibility"): Promise<VisibilityBrowserCapability>;
  get(id: string): Promise<BrowserCapability>;
  async get(id: string): Promise<BrowserCapability> {
    this.assertAvailable();
    const capability = this.#read().find((candidate) => candidate.id === id);
    if (!capability) throw new Error(`Browser capability '${id}' is unavailable`);
    if (id === "visibility" && this.execute) {
      return new VisibilityBrowserCapability(capability, this.#readDocumentation, this.execute);
    }
    return new BrowserCapability(capability.id, capability.description, this.#readDocumentation);
  }
}
