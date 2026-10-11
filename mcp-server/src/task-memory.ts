import { z } from "zod";

export const BOT_MEMORY_CAPABILITY = "bot_memory_v1";
export const MAX_TASK_MEMORY_BYTES = 128 * 1024;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const taskMemorySchema = z.object({
  version: z.literal(1),
  botId: identifier,
  runId: identifier,
  policyVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  callbackUrl: z.string().max(4096),
  callbackToken: z.string().min(32).max(2048),
  policy: z.object({ schemaVersion: z.literal(1), actions: z.array(z.record(z.unknown())).min(1).max(20) }).passthrough(),
  context: z.record(z.unknown()),
}).strict().superRefine((value, ctx) => {
  try {
    const url = new URL(value.callbackUrl);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
        || url.username || url.password || url.search || url.hash
        || url.pathname !== `/api/internal/bot-memory/${value.runId}`
        || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_TASK_MEMORY_BYTES) throw new Error();
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid private task memory transport." });
  }
});

export type TaskMemory = z.infer<typeof taskMemorySchema>;

export function validateTaskMemory(value: unknown): TaskMemory {
  const parsed = taskMemorySchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid task_memory envelope.");
  return parsed.data;
}

const privateKeys = new Set(["taskmemory", "botmemory", "taskmemoryciphertext", "taskmemoryrequired", "callbacktoken", "callbackurl"]);

export function redactTaskMemory(value: unknown, secrets: Iterable<string> = [], depth = 0, stripPrivateKeys = true): unknown {
  if ((Array.isArray(secrets) && !secrets.length) || (secrets instanceof Set && !secrets.size)) return value;
  if (depth > 32) return "[REDACTED]";
  if (typeof value === "string") {
    let safe = value;
    let reflected = false;
    for (const secret of secrets) if (secret && safe.includes(secret)) {
      reflected = true;
      safe = safe.split(secret).join("[REDACTED]");
    }
    if (reflected && /"(?:task_?memory|bot_?memory|callback_?(?:token|url))"\s*:/i.test(value.replace(/\\"/g, '"'))) return "[Private bot memory omitted]";
    return safe;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => redactTaskMemory(item, secrets, depth + 1, stripPrivateKeys));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !stripPrivateKeys || !privateKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")))
    .map(([key, nested]) => [key, redactTaskMemory(nested, secrets, depth + 1, stripPrivateKeys)]));
}

export function redactMemoryRunResponse(value: unknown, secrets: Iterable<string>, protectedRunIds: Set<string>, protectedRequest = false): unknown {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (result && Array.isArray(result.runs)) {
    return { ...redactTaskMemory(value, secrets) as Record<string, unknown>,
      runs: result.runs.map(run => redactMemoryRunResponse(run, secrets, protectedRunIds)) };
  }
  return redactTaskMemory(value, secrets, 0,
    protectedRequest || protectedRunIds.has(String(result?.runId || result?.run_id || "")));
}
