import fs from "node:fs";
import path from "node:path";

export type FirstmateSessionMode = "worker" | "primary" | "standalone";

/** Detect the Firstmate role from launch facts, never from prompt text. */
export function detectFirstmateMode(workspaceRoot: string, setting: "auto" | "off", taskId = process.env.FM_TASK_ID): FirstmateSessionMode {
  if (setting === "off") return "standalone";
  if (taskId) return "worker";
  try {
    const agents = fs.readFileSync(path.join(workspaceRoot, "AGENTS.md"), "utf8");
    if (agents.startsWith("# Firstmate") && fs.statSync(path.join(workspaceRoot, "bin", "fm-spawn.sh")).isFile()) return "primary";
  } catch { /* An ordinary workspace is standalone. */ }
  return "standalone";
}
