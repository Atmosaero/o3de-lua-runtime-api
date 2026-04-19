import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { readApiDumpFromText, resolveWorkspacePath } from "./apiProvider";
import { O3deLuaApi } from "./o3deApi";

export interface RuntimeCommandOptions {
  command: string;
  args: string[];
  cwd: string;
  outputPath: string;
  timeoutMs: number;
  useShell: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export async function readApiDumpFromRuntimeCommand(
  options: RuntimeCommandOptions,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<O3deLuaApi> {
  const command = expandWorkspaceTokens(options.command.trim(), workspaceFolder);
  if (!command) {
    throw new Error("Runtime command is empty. Set o3deLua.runtimeCommand to a bridge/exporter executable.");
  }

  const args = options.args.map((arg) => expandWorkspaceTokens(arg, workspaceFolder));
  const cwd = resolveRuntimeCwd(options.cwd, workspaceFolder);
  const result = await runCommand(command, args, cwd, options.timeoutMs, options.useShell);

  if (options.outputPath.trim()) {
    const outputPath = resolveWorkspacePath(expandWorkspaceTokens(options.outputPath.trim(), workspaceFolder), workspaceFolder);
    const raw = await fs.readFile(outputPath, "utf8");
    return readApiDumpFromText(raw);
  }

  return readApiDumpFromText(extractJsonObject(result.stdout, result.stderr));
}

function resolveRuntimeCwd(cwd: string, workspaceFolder: vscode.WorkspaceFolder): string {
  const expanded = expandWorkspaceTokens(cwd || "${workspaceFolder}", workspaceFolder);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }

  return path.join(workspaceFolder.uri.fsPath, expanded);
}

function expandWorkspaceTokens(value: string, workspaceFolder: vscode.WorkspaceFolder): string {
  return value.replace(/\$\{workspaceFolder\}/g, workspaceFolder.uri.fsPath);
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number, useShell: boolean): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: useShell,
      windowsHide: true
    });

    let settled = false;
    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill();
      reject(new Error(`Runtime command timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`Runtime command exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function extractJsonObject(stdout: string, stderr: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Runtime command did not write JSON to stdout.${stderr.trim() ? ` stderr: ${stderr.trim()}` : ""}`);
  }

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const candidate = trimmed.slice(start, end + 1);
      JSON.parse(candidate);
      return candidate;
    }

    throw new Error(`Runtime command stdout is not valid JSON.${stderr.trim() ? ` stderr: ${stderr.trim()}` : ""}`);
  }
}
