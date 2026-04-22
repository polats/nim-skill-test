/**
 * Docker-backed bash tool for pi-agent-core.
 *
 * Replaces pi-coding-agent's createBashTool, which as of v0.30.2 only
 * spawns on the host (dropped the {operations} parameter). Our agents
 * need to run commands *inside* a disposable Docker container, so we
 * wrap DockerBashOperations.exec into an AgentTool directly.
 */
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-ai";
import type { DockerBashOperations } from "./docker-bash-ops.js";

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
});

export function createDockerBashTool(
  ops: DockerBashOperations,
  cwd: string,
): AgentTool<typeof bashSchema> {
  return {
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command inside the isolated Docker container. Returns stdout and stderr combined. Optionally provide a timeout in seconds.",
    parameters: bashSchema,
    execute: async (_toolCallId, { command, timeout }, signal) => {
      const chunks: Buffer[] = [];
      const onData = (d: Buffer) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
      try {
        const res = await ops.exec(command, cwd, {
          onData,
          signal,
          timeout: timeout ?? 120,
        });
        const text = Buffer.concat(chunks).toString("utf-8");
        const header = `exit=${res.exitCode ?? "?"}\n`;
        return {
          content: [{ type: "text", text: header + text }],
          details: { exitCode: res.exitCode, bytes: Buffer.concat(chunks).length },
        };
      } catch (err) {
        const text = Buffer.concat(chunks).toString("utf-8");
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: ${msg}\n${text}` }],
          details: { exitCode: -1, error: msg },
        };
      }
    },
  };
}
