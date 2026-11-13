import type { Root } from "@zcode/ui";

export type RootServices = Parameters<typeof Root>[0]["services"];
export type ServiceMethod = (...args: any[]) => unknown;
