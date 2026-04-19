import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { normalizeApiDump, O3deLuaApi, O3deLuaApiDump } from "./o3deApi";

export async function readApiDumpFromJson(apiJsonPath: string, workspaceFolder?: vscode.WorkspaceFolder): Promise<O3deLuaApi> {
  const resolvedPath = resolveWorkspacePath(apiJsonPath, workspaceFolder);
  const raw = await fs.readFile(resolvedPath, "utf8");
  return readApiDumpFromText(raw);
}

export function readApiDumpFromText(raw: string): O3deLuaApi {
  const parsed = JSON.parse(raw) as O3deLuaApiDump;
  return normalizeApiDump(parsed);
}

export function resolveWorkspacePath(inputPath: string, workspaceFolder?: vscode.WorkspaceFolder): string {
  if (!inputPath) {
    throw new Error("Runtime API JSON path is empty.");
  }

  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  if (!workspaceFolder) {
    throw new Error(`Path "${inputPath}" is relative, but no VS Code workspace folder is open.`);
  }

  return path.join(workspaceFolder.uri.fsPath, inputPath);
}

export function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

export async function ensureParentDirectory(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}
