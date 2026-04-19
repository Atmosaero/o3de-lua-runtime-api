import { O3deLuaApi, ScriptUserEBusInfo, ScriptUserEBusMethodInfo, ScriptUserMethodInfo, ScriptUserPropertyInfo } from "./o3deApi";

export interface StubStats {
  ebusCount: number;
  ebusEventCount: number;
  classCount: number;
  globalMethodCount: number;
  globalPropertyCount: number;
}

export interface StubGenerationResult {
  text: string;
  stats: StubStats;
  warnings: string[];
}

interface LuaSignature {
  params: LuaParam[];
  returnType?: string;
}

interface LuaParam {
  name: string;
  type: string;
}

interface GenerationContext {
  classNames: Set<string>;
}

export function generateLuaStubs(api: O3deLuaApi): StubGenerationResult {
  const lines: string[] = [];
  const generationContext: GenerationContext = {
    classNames: new Set(api.classes.map((classInfo) => safeDocName(classInfo.name)))
  };
  const stats: StubStats = {
    ebusCount: api.ebuses.length,
    ebusEventCount: api.ebuses.reduce((count, bus) => count + bus.events.length, 0),
    classCount: api.classes.length,
    globalMethodCount: api.globals.methods.length,
    globalPropertyCount: api.globals.properties.length
  };

  lines.push("---@meta");
  lines.push("---@diagnostic disable: unused-local, lowercase-global, duplicate-set-field");
  lines.push("--- Generated from O3DE runtime-reflected Lua API.");
  if (api.generatedAt) {
    lines.push(`--- Source generated at: ${api.generatedAt}`);
  }
  if (api.source?.endpoint || api.source?.context) {
    lines.push(`--- Source: ${api.source.endpoint ?? "unknown endpoint"} / ${api.source.context ?? "unknown context"}`);
  }
  lines.push("");

  appendRuntimeHelpers(lines);
  appendGlobals(lines, api.globals.methods, api.globals.properties, generationContext);
  appendClasses(lines, api.classes, generationContext);
  appendEBuses(lines, api.ebuses, generationContext);

  return {
    text: `${lines.join("\n")}\n`,
    stats,
    warnings: validateLuaStubText(lines)
  };
}

function validateLuaStubText(lines: string[]): string[] {
  const warnings: string[] = [];
  const text = lines.join("\n");

  if (/^function\s*\(/m.test(text)) {
    warnings.push("Generated stub contains a function declaration with an empty name.");
  }
  if (/\n\s*=\s*/.test(text)) {
    warnings.push("Generated stub contains an assignment with an empty left-hand side.");
  }
  if (/---@class\s*$/.test(text)) {
    warnings.push("Generated stub contains an empty LuaLS class annotation.");
  }

  return warnings;
}

function appendRuntimeHelpers(lines: string[]): void {
  lines.push("-- O3DE Lua runtime helpers");
  lines.push("---@class O3deLuaEBusHandler");
  lines.push("---@field Connect fun(self: O3deLuaEBusHandler, busId?: EntityId)");
  lines.push("---@field Disconnect fun(self: O3deLuaEBusHandler)");
  lines.push("---@field IsConnected fun(self: O3deLuaEBusHandler): boolean");
  lines.push("local O3deLuaEBusHandler = {}");
  lines.push("");
}

function appendGlobals(
  lines: string[],
  methods: ScriptUserMethodInfo[],
  properties: ScriptUserPropertyInfo[],
  generationContext: GenerationContext
): void {
  if (methods.length === 0 && properties.length === 0) {
    return;
  }

  lines.push("-- Globals");
  for (const property of dedupeBy(properties, (item) => item.name).filter(isUsefulGlobalProperty)) {
    lines.push(`---@type any`);
    lines.push(`${emitPathAssignment(property.name, "nil")}`);
    lines.push("");
  }

  for (const method of dedupeBy(methods, (item) => item.name).filter(isUsefulGlobalMethod)) {
    appendGlobalFunction(lines, method, generationContext);
  }
}

function appendClasses(lines: string[], classes: O3deLuaApi["classes"], generationContext: GenerationContext): void {
  if (classes.length === 0) {
    return;
  }

  lines.push("-- Classes");
  for (const classInfo of dedupeBy(classes, (item) => item.name).filter(isUsefulClass)) {
    const methods = dedupeBy(classInfo.methods, (item) => item.name).filter(isUsefulClassMethod);
    lines.push(`---@class ${safeDocName(classInfo.name)}`);
    for (const property of dedupeBy(classInfo.properties, (item) => item.name)) {
      lines.push(`---@field ${safeFieldName(property.name)} ${inferPropertyType(classInfo.name, property)}`);
    }
    for (const method of methods) {
      lines.push(`---@field ${safeFieldName(method.name)} ${emitClassMethodFunctionType(classInfo.name, method, generationContext)}`);
    }
    lines.push(emitPathAssignment(classInfo.name, "{}"));
    lines.push("");
  }
}

function appendEBuses(lines: string[], ebuses: ScriptUserEBusInfo[], generationContext: GenerationContext): void {
  if (ebuses.length === 0) {
    return;
  }

  lines.push("-- EBuses");
  const ebusByName = new Map(ebuses.map((item) => [item.name, item]));
  for (const ebus of dedupeBy(ebuses, (item) => item.name)) {
    lines.push(`---@class ${safeDocName(ebus.name)}`);
    if (ebus.hasHandler) {
      lines.push("---@field CreateHandler fun(handlerTable: table): O3deLuaEBusHandler");
      lines.push(`---@field Connect ${emitEBusConnectFunctionType(ebus, ebusByName)}`);
    }
    lines.push(emitPathAssignment(ebus.name, "{}"));
    lines.push("");

    const categories = getCategories(ebus);
    for (const category of categories) {
      lines.push(`---@class ${safeDocName(`${ebus.name}.${category}`)}`);
      for (const event of dedupeEBusEvents(ebus.events).filter((item) => normalizeCategory(item.category) === category)) {
        lines.push(`---@field ${safeFieldName(event.name)} ${emitFunctionType(event.dbgParamInfo, generationContext, event.name)}`);
      }
      lines.push(emitPathAssignment(`${ebus.name}.${category}`, "{}"));
      lines.push("");
    }

  }
}

function appendGlobalFunction(lines: string[], method: ScriptUserMethodInfo, generationContext: GenerationContext): void {
  const signature = applyMethodReturnHeuristic(method.name, parseLuaSignature(method.dbgParamInfo), generationContext);
  for (const initializer of parentTableInitializers(method.name)) {
    lines.push(initializer);
  }
  lines.push(`---@type ${emitFunctionTypeFromSignature(signature)}`);
  lines.push(`${emitPathAssignment(method.name, "nil")}`);
  lines.push("");
}

function parentTableInitializers(functionName: string): string[] {
  const parts = functionName.split(":")[0].split(".").filter(Boolean);
  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    const parentPath = parts.slice(0, index).join(".");
    result.push(emitPathAssignment(parentPath, "{}"));
  }
  return result;
}

function getCategories(ebus: ScriptUserEBusInfo): string[] {
  const categories = new Set<string>();
  for (const event of ebus.events) {
    categories.add(normalizeCategory(event.category));
  }
  if (ebus.canBroadcast) {
    categories.add("Broadcast");
  }
  if (ebus.hasHandler) {
    categories.add("Notification");
  }
  return [...categories].sort();
}

function normalizeCategory(category: string): string {
  if (category === "Event" || category === "Broadcast" || category === "Notification") {
    return category;
  }
  return category || "Event";
}

function emitFunctionType(dbgParamInfo: string, generationContext: GenerationContext, methodName?: string): string {
  const signature = methodName
    ? applyMethodReturnHeuristic(methodName, parseLuaSignature(dbgParamInfo), generationContext)
    : parseLuaSignature(dbgParamInfo);
  return emitFunctionTypeFromSignature(signature);
}

function emitClassMethodFunctionType(
  className: string,
  method: ScriptUserMethodInfo,
  generationContext: GenerationContext
): string {
  const classDocName = safeDocName(className);
  const signature = applyMethodReturnHeuristic(method.name, parseLuaSignature(method.dbgParamInfo), generationContext);
  return emitFunctionTypeFromSignature(isInstanceMethodSignature(classDocName, signature)
    ? {
      ...signature,
      params: [
        { name: "self", type: classDocName },
        ...signature.params.slice(1)
      ]
    }
    : signature);
}

function emitFunctionTypeFromSignature(signature: LuaSignature): string {
  const params = signature.params.map((param) => `${param.name}: ${param.type}`);
  const returnSuffix = signature.returnType ? `: ${signature.returnType}` : "";
  return `fun(${params.join(", ")})${returnSuffix}`;
}

function parseLuaSignature(dbgParamInfo: string): LuaSignature {
  if (!dbgParamInfo.trim()) {
    return { params: [] };
  }

  const rawParams = splitDbgParamInfo(stripReturnInfo(dbgParamInfo));
  const params: LuaParam[] = [];
  const seen = new Map<string, number>();

  for (const rawParam of rawParams) {
    const param = parseLuaParam(rawParam, params.length + 1);
    if (!param) {
      continue;
    }

    const count = seen.get(param.name) ?? 0;
    seen.set(param.name, count + 1);
    params.push({
      ...param,
      name: count === 0 ? param.name : `${param.name}${count + 1}`
    });
  }

  return {
    params,
    returnType: parseReturnType(dbgParamInfo)
  };
}

function applyMethodReturnHeuristic(
  methodName: string,
  signature: LuaSignature,
  generationContext: GenerationContext
): LuaSignature {
  if (signature.returnType) {
    return signature;
  }
  const inferredReflectedType = inferReturnTypeFromKnownClassName(methodName, generationContext);
  if (inferredReflectedType) {
    return {
      ...signature,
      returnType: inferredReflectedType
    };
  }
  if (/^(Is|Has|Can|Contains|Equals|Equal)/.test(methodName)) {
    return {
      ...signature,
      returnType: "boolean"
    };
  }
  if (/^(Get|Find|Create|Clone).*(Entity|Element|Canvas|Parent|Child|Descendant|Ancestor)/.test(methodName)) {
    return {
      ...signature,
      returnType: "EntityId"
    };
  }
  if (/^(Get|Is|Has|Can).*(Enabled|Visible|State|Checked|Selected|Valid)/.test(methodName)) {
    return {
      ...signature,
      returnType: "boolean"
    };
  }
  if (/^Get.*(Count|Index|Number|Num|Order|Width|Height|Alpha|Value|Time|Seconds|Milliseconds)/.test(methodName)) {
    return {
      ...signature,
      returnType: "number"
    };
  }
  if (/^Get.*(Name|Text|String|Path|Label|Tooltip|ActionName)/.test(methodName)) {
    return {
      ...signature,
      returnType: "string"
    };
  }
  return signature;
}

function inferReturnTypeFromKnownClassName(methodName: string, generationContext: GenerationContext): string | undefined {
  if (!/^(Get|Find|Create|Clone|Resolve|Load|Spawn)/.test(methodName)) {
    return undefined;
  }

  const sortedClassNames = [...generationContext.classNames].sort((left, right) => right.length - left.length);
  for (const className of sortedClassNames) {
    if (className.length < 3) {
      continue;
    }
    const singular = className;
    const plural = pluralizeClassName(className);
    if (methodName.endsWith(plural)) {
      return `${className}[]`;
    }
    if (methodName.endsWith(singular)) {
      return className;
    }
  }

  return undefined;
}

function pluralizeClassName(className: string): string {
  if (className.endsWith("y")) {
    return `${className.slice(0, -1)}ies`;
  }
  if (className.endsWith("s")) {
    return `${className}es`;
  }
  return `${className}s`;
}

function isInstanceMethodSignature(classDocName: string, signature: LuaSignature): boolean {
  return signature.params[0]?.type === classDocName;
}

function parseReturnType(dbgParamInfo: string): string | undefined {
  const match = dbgParamInfo.match(/^\s*\[=([^\]]*)\]/);
  return match ? normalizeLuaType(match[1]) : undefined;
}

function stripReturnInfo(dbgParamInfo: string): string {
  return dbgParamInfo.replace(/^\s*\[=[^\]]*\]\s*/, "");
}

function splitDbgParamInfo(dbgParamInfo: string): string[] {
  const result: string[] = [];
  let current = "";
  let angleDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (const char of dbgParamInfo) {
    if (char === "<") {
      angleDepth += 1;
    } else if (char === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]" && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (char === "(") {
      parenDepth += 1;
    } else if (char === ")" && parenDepth > 0) {
      parenDepth -= 1;
    }

    if (char === "," && angleDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    result.push(current);
  }

  return result;
}

function parseLuaParam(raw: string, position: number): LuaParam | undefined {
  const cleaned = raw.split("=")[0]?.trim() ?? "";
  if (!cleaned || cleaned === "void" || looksLikeDocumentationText(cleaned)) {
    return undefined;
  }

  const candidate = cleaned
    .replace(/[&*]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .pop() ?? "arg";
  if (looksLikeTypeName(cleaned) || looksLikeTypeName(candidate)) {
    return {
      name: `arg${position}`,
      type: normalizeLuaType(cleaned) ?? "any"
    };
  }

  return {
    name: toIdentifier(candidate, `arg${position}`),
    type: "any"
  };
}

function looksLikeDocumentationText(input: string): boolean {
  return /[.!?']/.test(input) || (!looksLikeTypeName(input) && input.trim().split(/\s+/).length > 1);
}

function isUsefulGlobalMethod(method: ScriptUserMethodInfo): boolean {
  return !method.name.startsWith("ScriptCanvas_");
}

function isUsefulGlobalProperty(property: ScriptUserPropertyInfo): boolean {
  return Boolean(property.name) && !property.name.startsWith("ScriptCanvas_");
}

function isUsefulClass(classInfo: O3deLuaApi["classes"][number]): boolean {
  if (/^(Iterator_|vector_|unordered_|unordered_map_|map_|set_|pair_)/.test(classInfo.name)) {
    return false;
  }

  const methodNames = new Set(classInfo.methods.map((method) => method.name));
  const looksLikeContainer =
    methodNames.has("Iterate_VM") ||
    methodNames.has("PushBack") ||
    methodNames.has("pop_back") ||
    methodNames.has("Capacity");
  return !looksLikeContainer;
}

function isUsefulClassMethod(method: ScriptUserMethodInfo): boolean {
  return method.name !== "AcquireOwnership" && method.name !== "ReleaseOwnership";
}

function inferPropertyType(className: string, property: ScriptUserPropertyInfo): string {
  const name = property.name;
  if (/(EntityId|entityId|Entity)$/.test(name)) {
    return "EntityId";
  }
  if (/(Name|name|Text|text|String|string|Path|path|Label|label|Tooltip|tooltip|ActionName)$/.test(name)) {
    return "string";
  }
  if (/(Enabled|enabled|Visible|visible|Valid|valid|Checked|checked|Selected|selected|Active|active)$/.test(name)) {
    return "boolean";
  }
  if (/(Count|count|Index|index|Number|number|Num|num|Order|order|Width|width|Height|height|Alpha|alpha|Value|value|Time|time|Seconds|seconds|Milliseconds|milliseconds|Id|id|Status|status)$/.test(name)) {
    return "number";
  }

  return "any";
}

function looksLikeTypeName(input: string): boolean {
  return (
    input.includes("::") ||
    input.includes("<") ||
    input.includes(">") ||
    input.includes("[") ||
    /^[A-Z]/.test(input) ||
    /^(bool|char|double|float|int|short|long|unsignedint|unsigned int|size_t)$/.test(input)
  );
}

function normalizeLuaType(rawType: string): string | undefined {
  const cleaned = rawType
    .replace(/\bconst\b/g, "")
    .replace(/\bclass\b/g, "")
    .replace(/\bstruct\b/g, "")
    .replace(/[&*]/g, "")
    .trim();
  const compact = cleaned.replace(/\s+/g, "");
  const lower = compact.toLowerCase();

  if (!compact || lower === "void") {
    return undefined;
  }
  if (lower === "bool" || lower === "boolean") {
    return "boolean";
  }
  if (/^(double|float|int|short|long|unsignedint|uint\d+|az::u\d+|az_u\d+|size_t)$/.test(lower)) {
    return "number";
  }
  if (lower === "char" || lower === "string" || lower.includes("basic_string")) {
    return "string";
  }
  if (lower === "[enum]" || lower === "enum") {
    return "integer";
  }
  if (lower.includes("vector") || lower.includes("tuple") || lower.includes("array")) {
    return "table";
  }
  if (compact === "AZ::EntityId" || compact === "EntityId") {
    return "EntityId";
  }
  if (compact === "AZ::Uuid" || compact === "Uuid") {
    return "Uuid";
  }

  return safeDocName(compact.replace(/::/g, "_"));
}

function emitEBusConnectFunctionType(ebus: ScriptUserEBusInfo, ebusByName: Map<string, ScriptUserEBusInfo>): string {
  const busIdType = inferBusIdType(ebus, ebusByName);
  return busIdType
    ? `fun(handlerTable: table, busId?: ${busIdType}): O3deLuaEBusHandler`
    : "fun(handlerTable: table): O3deLuaEBusHandler";
}

function inferBusIdType(ebus: ScriptUserEBusInfo, ebusByName: Map<string, ScriptUserEBusInfo>): string | undefined {
  const direct = inferBusIdTypeFromEvents(ebus);
  if (direct) {
    return direct;
  }

  const related = inferRelatedRequestBus(ebus, ebusByName);
  return related ? inferBusIdTypeFromEvents(related) : undefined;
}

function inferRelatedRequestBus(ebus: ScriptUserEBusInfo, ebusByName: Map<string, ScriptUserEBusInfo>): ScriptUserEBusInfo | undefined {
  const candidates = [
    ebus.name.replace(/NotificationBus$/, "Bus"),
    ebus.name.replace(/NotificationsBus$/, "Bus"),
    ebus.name.replace(/NotificationBus$/, "RequestBus"),
    ebus.name.replace(/NotificationsBus$/, "RequestBus")
  ].filter((name) => name !== ebus.name);

  for (const candidate of candidates) {
    const related = ebusByName.get(candidate);
    if (related) {
      return related;
    }
  }

  return undefined;
}

function inferBusIdTypeFromEvents(ebus: ScriptUserEBusInfo): string | undefined {
  const broadcasts = new Map<string, LuaSignature>();
  for (const event of ebus.events) {
    if (normalizeCategory(event.category) === "Broadcast") {
      broadcasts.set(event.name, parseLuaSignature(event.dbgParamInfo));
    }
  }

  for (const event of ebus.events) {
    if (normalizeCategory(event.category) !== "Event") {
      continue;
    }

    const eventSignature = parseLuaSignature(event.dbgParamInfo);
    const broadcastSignature = broadcasts.get(event.name);
    if (broadcastSignature && eventSignature.params.length === broadcastSignature.params.length + 1) {
      return eventSignature.params[0]?.type;
    }
  }

  return undefined;
}

function emitPathAssignment(dottedName: string, value: string): string {
  const parts = dottedName.split(".").filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  return `${emitExpressionPath(parts)} = ${emitExpressionPath(parts)} or ${value}`;
}

function emitExpressionPath(parts: string[]): string {
  if (parts.length === 0) {
    return "_G";
  }

  const [first, ...rest] = parts;
  let output = isIdentifier(first) ? first : `_G[${quoteLuaString(first)}]`;
  for (const part of rest) {
    output += isIdentifier(part) ? `.${part}` : `[${quoteLuaString(part)}]`;
  }
  return output;
}

function toIdentifier(input: string, fallback: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9_]/g, "_");
  if (isIdentifier(cleaned) && !isLuaKeyword(cleaned)) {
    return cleaned;
  }
  const prefixed = `_${cleaned}`;
  return isIdentifier(prefixed) && !isLuaKeyword(prefixed) ? prefixed : fallback;
}

function isIdentifier(input: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(input) && !isLuaKeyword(input);
}

function safeDocName(input: string): string {
  return input
    .split(".")
    .map((part) => toIdentifier(part, "Unknown"))
    .join(".");
}

function safeFieldName(input: string): string {
  return isIdentifier(input) ? input : `[${quoteLuaString(input)}]`;
}

function quoteLuaString(input: string): string {
  return JSON.stringify(input);
}

function isLuaKeyword(input: string): boolean {
  return new Set([
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
    "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return",
    "then", "true", "until", "while"
  ]).has(input);
}

function dedupeBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function dedupeEBusEvents(events: ScriptUserEBusMethodInfo[]): ScriptUserEBusMethodInfo[] {
  return dedupeBy(events, (event) => `${normalizeCategory(event.category)}:${event.name}:${event.dbgParamInfo}`);
}
