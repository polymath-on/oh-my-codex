import { join } from "path";
import { codexHome } from "../utils/paths.js";

export const OMX_NATIVE_HOOK_STATUS_PREFIX = "OMX native hook:";
export const OMX_NATIVE_HOOK_COMMAND_BASENAME = "codex-native-hook.js";

export const MANAGED_NATIVE_HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
] as const;

export type ManagedNativeHookEvent = (typeof MANAGED_NATIVE_HOOK_EVENTS)[number];

export interface NativeHookHandler {
  type: "command";
  command: string;
  statusMessage?: string;
  timeout?: number;
  timeoutSec?: number;
}

export interface NativeHookMatcherGroup {
  matcher?: string;
  hooks: NativeHookHandler[];
}

export interface NativeHooksFile {
  hooks?: Record<string, NativeHookMatcherGroup[]>;
  [key: string]: unknown;
}

export type NativeHooksScope = "user" | "project";

function escapeDoubleQuotedShellPath(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function buildManagedNativeHookCommand(
  pkgRoot: string,
  scope: NativeHooksScope,
): string {
  if (scope === "project") {
    return 'node "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/dist/scripts/codex-native-hook.js"';
  }

  return `node "${escapeDoubleQuotedShellPath(join(pkgRoot, "dist", "scripts", OMX_NATIVE_HOOK_COMMAND_BASENAME))}"`;
}

export function codexHooksFilePath(
  scope: NativeHooksScope,
  projectRoot = process.cwd(),
): string {
  return scope === "project"
    ? join(projectRoot, ".codex", "hooks.json")
    : join(codexHome(), "hooks.json");
}

export function buildManagedNativeHooksFile(
  pkgRoot: string,
  scope: NativeHooksScope,
): NativeHooksFile {
  const command = buildManagedNativeHookCommand(pkgRoot, scope);

  return {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              command,
              statusMessage: `${OMX_NATIVE_HOOK_STATUS_PREFIX} SessionStart`,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command,
              statusMessage: `${OMX_NATIVE_HOOK_STATUS_PREFIX} PreToolUse`,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command,
              statusMessage: `${OMX_NATIVE_HOOK_STATUS_PREFIX} PostToolUse`,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command,
              statusMessage: `${OMX_NATIVE_HOOK_STATUS_PREFIX} UserPromptSubmit`,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command,
              statusMessage: `${OMX_NATIVE_HOOK_STATUS_PREFIX} Stop`,
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
}

function asHooksRecord(value: unknown): Record<string, NativeHookMatcherGroup[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, NativeHookMatcherGroup[]>;
}

export function parseNativeHooksFile(content: string): NativeHooksFile {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hooks.json must contain a JSON object");
  }
  return parsed as NativeHooksFile;
}

export function isOmxManagedNativeHookGroup(group: unknown): boolean {
  if (!group || typeof group !== "object" || Array.isArray(group)) return false;
  const hooks = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;

  return hooks.some((hook) => {
    if (!hook || typeof hook !== "object" || Array.isArray(hook)) return false;
    const command = typeof (hook as { command?: unknown }).command === "string"
      ? (hook as { command: string }).command
      : "";
    const statusMessage = typeof (hook as { statusMessage?: unknown }).statusMessage === "string"
      ? (hook as { statusMessage: string }).statusMessage
      : "";
    return command.includes(OMX_NATIVE_HOOK_COMMAND_BASENAME)
      || statusMessage.startsWith(OMX_NATIVE_HOOK_STATUS_PREFIX);
  });
}

export function mergeManagedNativeHooks(
  existing: NativeHooksFile,
  managed: NativeHooksFile,
): NativeHooksFile {
  const existingHooks = asHooksRecord(existing.hooks);
  const managedHooks = asHooksRecord(managed.hooks);
  const mergedHooks: Record<string, NativeHookMatcherGroup[]> = {};

  for (const [eventName, groups] of Object.entries(existingHooks)) {
    mergedHooks[eventName] = Array.isArray(groups) ? [...groups] : [];
  }

  for (const eventName of Object.keys(managedHooks)) {
    const preserved = (mergedHooks[eventName] || []).filter(
      (group) => !isOmxManagedNativeHookGroup(group),
    );
    mergedHooks[eventName] = [...preserved, ...(managedHooks[eventName] || [])];
  }

  return {
    ...existing,
    hooks: mergedHooks,
  };
}

export function serializeNativeHooksFile(config: NativeHooksFile): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
