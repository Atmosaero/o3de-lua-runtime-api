export interface O3deLuaApiDump {
  version?: number;
  generatedAt?: string;
  source?: {
    endpoint?: string;
    context?: string;
  };
  contexts?: string[];
  globals?: {
    methods?: ScriptUserMethodInfoLike[];
    properties?: ScriptUserPropertyInfoLike[];
    m_methods?: ScriptUserMethodInfoLike[];
    m_properties?: ScriptUserPropertyInfoLike[];
  };
  classes?: ScriptUserClassInfoLike[];
  ebuses?: ScriptUserEBusInfoLike[];
  EBusses?: ScriptUserEBusInfoLike[];
  m_ebusList?: ScriptUserEBusInfoLike[];
}

export interface ScriptUserMethodInfo {
  name: string;
  dbgParamInfo: string;
}

export interface ScriptUserPropertyInfo {
  name: string;
  isRead: boolean;
  isWrite: boolean;
}

export interface ScriptUserClassInfo {
  name: string;
  methods: ScriptUserMethodInfo[];
  properties: ScriptUserPropertyInfo[];
}

export type EBusEventCategory = "Event" | "Broadcast" | "Notification" | string;

export interface ScriptUserEBusMethodInfo extends ScriptUserMethodInfo {
  category: EBusEventCategory;
}

export interface ScriptUserEBusInfo {
  name: string;
  events: ScriptUserEBusMethodInfo[];
  canBroadcast: boolean;
  canQueue: boolean;
  hasHandler: boolean;
}

export interface O3deLuaApi {
  version: number;
  generatedAt?: string;
  source?: {
    endpoint?: string;
    context?: string;
  };
  contexts: string[];
  globals: {
    methods: ScriptUserMethodInfo[];
    properties: ScriptUserPropertyInfo[];
  };
  classes: ScriptUserClassInfo[];
  ebuses: ScriptUserEBusInfo[];
}

type ScriptUserMethodInfoLike = Partial<ScriptUserMethodInfo> & {
  m_name?: unknown;
  m_dbgParamInfo?: unknown;
  info?: unknown;
};

type ScriptUserPropertyInfoLike = Partial<ScriptUserPropertyInfo> & {
  m_name?: unknown;
  m_isRead?: unknown;
  m_isWrite?: unknown;
};

type ScriptUserClassInfoLike = Partial<ScriptUserClassInfo> & {
  m_name?: unknown;
  m_methods?: ScriptUserMethodInfoLike[];
  m_properties?: ScriptUserPropertyInfoLike[];
};

type ScriptUserEBusMethodInfoLike = Partial<ScriptUserEBusMethodInfo> & {
  m_name?: unknown;
  m_dbgParamInfo?: unknown;
  m_category?: unknown;
  info?: unknown;
};

type ScriptUserEBusInfoLike = Partial<ScriptUserEBusInfo> & {
  m_name?: unknown;
  m_events?: ScriptUserEBusMethodInfoLike[];
  m_canBroadcast?: unknown;
  m_canQueue?: unknown;
  m_hasHandler?: unknown;
};

export function normalizeApiDump(input: O3deLuaApiDump): O3deLuaApi {
  const globals = input.globals ?? {};
  const ebuses = arrayValue<ScriptUserEBusInfoLike>(input.ebuses ?? input.EBusses ?? input.m_ebusList);

  return {
    version: numberOrDefault(input.version, 1),
    generatedAt: stringOrUndefined(input.generatedAt),
    source: input.source,
    contexts: arrayValue<unknown>(input.contexts).map(String).filter(Boolean),
    globals: {
      methods: normalizeMethods(arrayValue<ScriptUserMethodInfoLike>(globals.methods ?? globals.m_methods)),
      properties: normalizeProperties(arrayValue<ScriptUserPropertyInfoLike>(globals.properties ?? globals.m_properties))
    },
    classes: arrayValue<ScriptUserClassInfoLike>(input.classes).map(normalizeClass).filter((item) => item.name.length > 0),
    ebuses: ebuses.map(normalizeEBus).filter((item) => item.name.length > 0)
  };
}

function normalizeClass(input: ScriptUserClassInfoLike): ScriptUserClassInfo {
  return {
    name: stringValue(input.name, input.m_name),
    methods: normalizeMethods(arrayValue<ScriptUserMethodInfoLike>(input.methods ?? input.m_methods)),
    properties: normalizeProperties(arrayValue<ScriptUserPropertyInfoLike>(input.properties ?? input.m_properties))
  };
}

function normalizeEBus(input: ScriptUserEBusInfoLike): ScriptUserEBusInfo {
  return {
    name: stringValue(input.name, input.m_name),
    events: normalizeEBusEvents(arrayValue<ScriptUserEBusMethodInfoLike>(input.events ?? input.m_events)),
    canBroadcast: booleanValue(input.canBroadcast, input.m_canBroadcast),
    canQueue: booleanValue(input.canQueue, input.m_canQueue),
    hasHandler: booleanValue(input.hasHandler, input.m_hasHandler)
  };
}

function normalizeMethods(inputs: ScriptUserMethodInfoLike[]): ScriptUserMethodInfo[] {
  return inputs
    .map((input) => ({
      name: stringValue(input.name, input.m_name),
      dbgParamInfo: stringValue(input.dbgParamInfo, input.m_dbgParamInfo, input.info)
    }))
    .filter((item) => item.name.length > 0);
}

function normalizeProperties(inputs: ScriptUserPropertyInfoLike[]): ScriptUserPropertyInfo[] {
  return inputs
    .map((input) => ({
      name: stringValue(input.name, input.m_name),
      isRead: booleanValue(input.isRead, input.m_isRead),
      isWrite: booleanValue(input.isWrite, input.m_isWrite)
    }))
    .filter((item) => item.name.length > 0);
}

function normalizeEBusEvents(inputs: ScriptUserEBusMethodInfoLike[]): ScriptUserEBusMethodInfo[] {
  return inputs
    .map((input) => ({
      name: stringValue(input.name, input.m_name),
      dbgParamInfo: stringValue(input.dbgParamInfo, input.m_dbgParamInfo, input.info),
      category: stringValue(input.category, input.m_category)
    }))
    .filter((item) => item.name.length > 0);
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return "";
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return false;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function arrayValue<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  return value === undefined ? [] : [value as T];
}
