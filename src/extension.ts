import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { ensureParentDirectory, getPrimaryWorkspaceFolder, readApiDumpFromJson, resolveWorkspacePath } from "./apiProvider";
import { generateLuaStubs, StubStats } from "./luaStubGenerator";
import { readApiDumpFromRuntimeCommand, RuntimeCommandOptions } from "./runtimeProvider";
import { normalizeApiDump, O3deLuaApi } from "./o3deApi";
import { RemoteToolsHost } from "./remoteToolsHost";

const extensionSection = "o3deLua";
type ApiSource = "jsonFile" | "command" | "remoteTools";
let remoteToolsHost: RemoteToolsHost | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const remoteToolsOutput = vscode.window.createOutputChannel("O3DE Lua RemoteTools");
  remoteToolsHost = new RemoteToolsHost(remoteToolsOutput);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "o3deLua.refreshApiFromEditor";
  status.text = "$(sync) O3DE Lua API";
  status.tooltip = "Refresh O3DE Lua API from O3DE Editor";
  status.show();

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("o3deLua.refreshApiFromEditor", () => refreshApiStubs(context, { forceSource: "remoteTools" }))
  );
}

export function deactivate(): void {
  remoteToolsHost?.dispose();
  remoteToolsHost = undefined;
}

async function refreshApiStubs(context: vscode.ExtensionContext, options: { forceSource?: ApiSource } = {}): Promise<void> {
  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a workspace folder before generating O3DE Lua stubs.");
    return;
  }

  const config = vscode.workspace.getConfiguration(extensionSection, workspaceFolder.uri);
  const resolvedStubPath = resolveGeneratedStubPath(context, config, workspaceFolder);

  try {
    const api = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Reading O3DE Lua runtime API",
        cancellable: false
      },
      () => loadApiFromConfiguredSource(config, workspaceFolder, options.forceSource)
    );
    const result = generateLuaStubs(api);
    await ensureParentDirectory(resolvedStubPath);
    await fs.writeFile(resolvedStubPath, result.text, "utf8");
    await fs.writeFile(replaceExtension(resolvedStubPath, ".runtime.json"), `${JSON.stringify(api, null, 2)}\n`, "utf8");

    if (config.get<boolean>("updateLuaWorkspaceLibrary") ?? true) {
      await addLuaWorkspaceLibrary(resolvedStubPath, workspaceFolder);
    }

    const message = `Generated O3DE Lua stubs: ${formatStats(result.stats)}.`;
    if (result.warnings.length > 0) {
      vscode.window.showWarningMessage(`${message} Sanity warnings: ${result.warnings.join(" ")}`);
    } else {
      vscode.window.showInformationMessage(message);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to generate O3DE Lua stubs: ${errorMessage(error)}`);
  }
}

async function loadApiFromConfiguredSource(
  config: vscode.WorkspaceConfiguration,
  workspaceFolder: vscode.WorkspaceFolder,
  forceSource?: ApiSource
): Promise<O3deLuaApi> {
  const source = forceSource ?? (config.get<ApiSource>("apiSource") || "jsonFile");

  if (source === "command") {
    return readApiDumpFromRuntimeCommand(readRuntimeCommandOptions(config), workspaceFolder);
  }

  if (source === "remoteTools") {
    const timeoutMs = config.get<number>("remoteToolsTimeoutMs") ?? 30000;
    const dump = await remoteToolsHost?.refreshApiFromEditor(timeoutMs);
    if (!dump) {
      throw new Error("RemoteTools host is not initialized.");
    }
    return normalizeApiDump(dump);
  }

  let apiJsonPath: string | undefined = config.get<string>("apiJsonPath") ?? "";
  if (!apiJsonPath) {
    apiJsonPath = await promptForApiJsonPath(config);
    if (!apiJsonPath) {
      throw new Error("No runtime API JSON was selected.");
    }
  }

  return readApiDumpFromJson(apiJsonPath, workspaceFolder);
}

function readRuntimeCommandOptions(config: vscode.WorkspaceConfiguration): RuntimeCommandOptions {
  return {
    command: config.get<string>("runtimeCommand") ?? "",
    args: config.get<string[]>("runtimeArgs") ?? [],
    cwd: config.get<string>("runtimeCwd") || "${workspaceFolder}",
    outputPath: config.get<string>("runtimeOutputPath") ?? "",
    timeoutMs: config.get<number>("runtimeTimeoutMs") ?? 30000,
    useShell: config.get<boolean>("runtimeUseShell") ?? false
  };
}

async function selectApiJson(): Promise<void> {
  const config = vscode.workspace.getConfiguration(extensionSection);
  await promptForApiJsonPath(config);
}

async function createSampleApiJson(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a workspace folder before creating the sample API JSON.");
    return;
  }

  const sampleSource = vscode.Uri.joinPath(context.extensionUri, "samples", "o3de-api.sample.json");
  const sampleTarget = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, ".vscode", "o3de-api.sample.json"));

  try {
    await fs.mkdir(path.dirname(sampleTarget.fsPath), { recursive: true });
    await fs.copyFile(sampleSource.fsPath, sampleTarget.fsPath);

    const config = vscode.workspace.getConfiguration(extensionSection, workspaceFolder.uri);
    await config.update("apiJsonPath", ".vscode/o3de-api.sample.json", vscode.ConfigurationTarget.Workspace);

    const document = await vscode.workspace.openTextDocument(sampleTarget);
    await vscode.window.showTextDocument(document);
    vscode.window.showInformationMessage("Created sample O3DE runtime API JSON.");
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to create sample O3DE API JSON: ${errorMessage(error)}`);
  }
}

async function openGeneratedStub(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = getPrimaryWorkspaceFolder();
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Open a workspace folder before opening the generated stub.");
    return;
  }

  const config = vscode.workspace.getConfiguration(extensionSection, workspaceFolder.uri);
  const resolvedStubPath = resolveGeneratedStubPath(context, config, workspaceFolder);

  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedStubPath));
    await vscode.window.showTextDocument(document);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not open generated O3DE Lua stub: ${errorMessage(error)}`);
  }
}

async function startRemoteToolsHost(output: vscode.OutputChannel): Promise<void> {
  try {
    output.show(true);
    await remoteToolsHost?.start();
    vscode.window.showInformationMessage("O3DE Lua RemoteTools host is listening on 127.0.0.1:6777.");
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to start O3DE Lua RemoteTools host: ${errorMessage(error)}`);
  }
}

async function stopRemoteToolsHost(): Promise<void> {
  await remoteToolsHost?.stop();
}

function showRemoteToolsStatus(output: vscode.OutputChannel): void {
  output.show(true);
  const current = remoteToolsHost?.getStatus();
  if (!current) {
    vscode.window.showWarningMessage("O3DE Lua RemoteTools host is not initialized.");
    return;
  }

  vscode.window.showInformationMessage(
    `RemoteTools host: listening=${current.listening}, connections=${current.connections}, lastEndpoint=${current.lastEndpoint ?? "none"}, lastPacketType=${current.lastPacketType ?? "none"}.`
  );
}

async function promptForApiJsonPath(config: vscode.WorkspaceConfiguration): Promise<string | undefined> {
  const files = await vscode.window.showOpenDialog({
    title: "Select O3DE runtime API JSON",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: {
      "JSON": ["json"]
    }
  });

  const selectedPath = files?.[0]?.fsPath;
  if (!selectedPath) {
    return undefined;
  }

  await config.update("apiJsonPath", selectedPath, vscode.ConfigurationTarget.Workspace);
  return selectedPath;
}

async function addLuaWorkspaceLibrary(libraryPath: string, workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const config = vscode.workspace.getConfiguration("Lua", workspaceFolder.uri);
  const current = config.get<unknown>("workspace.library");
  const normalizedLibraryPath = normalizeFsPath(libraryPath);
  const normalizedLibraryDir = normalizeFsPath(path.dirname(libraryPath));
  const legacyLibraryPath = normalizeFsPath(path.join(workspaceFolder.uri.fsPath, ".vscode", "o3de-lua-api.lua"));
  const legacyLibraryDir = normalizeFsPath(path.join(workspaceFolder.uri.fsPath, ".vscode"));

  let next: string[];
  if (Array.isArray(current)) {
    next = current.filter((item): item is string => typeof item === "string");
  } else if (current && typeof current === "object") {
    next = Object.entries(current)
      .filter(([, enabled]) => enabled !== false)
      .map(([item]) => item);
  } else {
    next = [];
  }

  next = next.filter((item) => {
    const normalizedItem = normalizeFsPath(item);
    return (
      normalizedItem !== normalizedLibraryPath &&
      normalizedItem !== normalizedLibraryDir &&
      normalizedItem !== legacyLibraryPath &&
      normalizedItem !== legacyLibraryDir
    );
  });
  next.push(libraryPath);
  await config.update("workspace.library", next, vscode.ConfigurationTarget.Workspace);
}

function resolveGeneratedStubPath(
  context: vscode.ExtensionContext,
  config: vscode.WorkspaceConfiguration,
  workspaceFolder: vscode.WorkspaceFolder
): string {
  const configuredPath = config.get<string>("stubOutputPath")?.trim() ?? "";
  if (configuredPath && normalizeFsPath(configuredPath) !== normalizeFsPath(".vscode/o3de-lua-api.lua")) {
    return resolveConfiguredStubPath(configuredPath, workspaceFolder);
  }

  return path.join(
    context.globalStorageUri.fsPath,
    "workspaces",
    `${sanitizePathPart(workspaceFolder.name)}-${hashString(workspaceFolder.uri.fsPath)}`,
    "o3de-lua-api.lua"
  );
}

function resolveConfiguredStubPath(configuredPath: string, workspaceFolder: vscode.WorkspaceFolder): string {
  const resolvedPath = resolveWorkspacePath(configuredPath, workspaceFolder);
  const parsed = path.parse(resolvedPath);
  if (!parsed.ext || configuredPath.endsWith("/") || configuredPath.endsWith("\\")) {
    return path.join(resolvedPath, "o3de-lua-api.lua");
  }
  return resolvedPath;
}

function sanitizePathPart(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, "_") || "workspace";
}

function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (const char of input.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeFsPath(filePath: string): string {
  return path.normalize(filePath).toLowerCase();
}

function formatStats(stats: StubStats): string {
  return [
    `${stats.ebusCount} EBuses`,
    `${stats.ebusEventCount} EBus events`,
    `${stats.classCount} classes`,
    `${stats.globalMethodCount} global methods`,
    `${stats.globalPropertyCount} global properties`
  ].join(", ");
}

function replaceExtension(filePath: string, extension: string): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
