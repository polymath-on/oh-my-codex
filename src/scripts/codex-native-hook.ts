#!/usr/bin/env node

import { dispatchHookEventRuntime } from "../hooks/extensibility/runtime.js";
import {
  buildHookEvent,
  buildNativeHookEvent,
} from "../hooks/extensibility/events.js";

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

type NativeHookInput = Record<string, unknown>;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function normalizeHookEventName(raw: string): string {
  switch (raw) {
    case "SessionStart":
      return "session-start";
    case "PreToolUse":
      return "pre-tool-use";
    case "PostToolUse":
      return "post-tool-use";
    case "UserPromptSubmit":
      return "user-prompt-submit";
    case "Stop":
      return "stop";
    default:
      return raw;
  }
}

function buildEvent(input: NativeHookInput) {
  const hookEventName = safeString(input.hook_event_name);
  const eventName = normalizeHookEventName(hookEventName);
  const context: Record<string, unknown> = {
    ...input,
    hook_event_name: hookEventName,
  };

  const options = {
    session_id: safeString(input.session_id),
    turn_id: safeString(input.turn_id),
  };

  if (hookEventName === "SessionStart") {
    return buildNativeHookEvent(eventName, context, options);
  }

  return buildHookEvent(eventName, {
    source: "native",
    context,
    ...options,
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) return;

  const parsed = JSON.parse(raw) as NativeHookInput;
  const cwd = safeString(parsed.cwd) || process.cwd();
  const event = buildEvent(parsed);
  await dispatchHookEventRuntime({
    cwd,
    event,
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[codex-native-hook] ${message}`);
  process.exitCode = 1;
});
