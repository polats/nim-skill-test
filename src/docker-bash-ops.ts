/**
 * Docker-based BashOperations for pi-coding-agent.
 * Each agent gets its own Docker container with node:20-slim.
 */

import { execSync, spawn } from "child_process";
import type { BashOperations } from "@mariozechner/pi-coding-agent";

export class DockerBashOperations implements BashOperations {
  public containerId: string | null = null;

  /** Create a container (stopped). Returns container ID. */
  createContainer(image = "node:20-slim"): string {
    const id = execSync(`docker create -it --network host ${image} bash`, {
      encoding: "utf-8",
    }).trim();
    this.containerId = id;
    return id;
  }

  /** Start the container. */
  startContainer(id?: string): void {
    const cid = id ?? this.containerId;
    if (!cid) throw new Error("No container ID");
    execSync(`docker start ${cid}`, { encoding: "utf-8" });
  }

  /** Remove the container forcefully. */
  destroyContainer(id?: string): void {
    const cid = id ?? this.containerId;
    if (!cid) return;
    try {
      execSync(`docker rm -f ${cid}`, { encoding: "utf-8", stdio: "pipe" });
    } catch {
      // already removed
    }
    if (cid === this.containerId) this.containerId = null;
  }

  /** BashOperations.exec — run a command inside the container. */
  exec: BashOperations["exec"] = (command, cwd, { onData, signal, timeout }) => {
    return new Promise((resolve, reject) => {
      const cid = this.containerId;
      if (!cid) {
        reject(new Error("No container ID — call createContainer() first"));
        return;
      }

      // spawn() passes args directly — no shell escaping needed
      const child = spawn(
        "docker",
        ["exec", "-w", cwd, cid, "bash", "-c", command],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeout * 1000);
      }

      if (child.stdout) child.stdout.on("data", onData);
      if (child.stderr) child.stderr.on("data", onData);

      child.on("error", (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(err);
      });

      const onAbort = () => child.kill("SIGKILL");
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.on("close", (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (timedOut) {
          reject(new Error(`timeout:${timeout}`));
          return;
        }
        resolve({ exitCode: code });
      });
    });
  };
}
