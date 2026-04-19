import { Buffer } from "node:buffer";
import { O3deLuaApiDump } from "./o3deApi";
import { azCrc32 } from "./scriptDebugProtocol";

interface ObjectStreamNode {
  typeId: string;
  nameCrc?: number;
  value?: Buffer;
  children: ObjectStreamNode[];
}

const binaryTag = 0;
const elementEnd = 0;
const hasValue = 1 << 4;
const extraSizeField = 1 << 5;
const hasName = 1 << 6;
const hasVersion = 1 << 7;
const valueSizeMask = 0x07;

const typeId = {
  string: "{03AAAB3F-5C47-5A66-9EBC-D5FA4DB353C9}",
  bool: "{A0CA880C-AFE4-43CB-926C-59AC48496112}",
  u32: "{43DA906B-7DEF-4CA8-9790-854106D3F983}",
  u64: "{D6597933-47CD-4FC8-B911-63F3E2B0993A}",
  uuid: "{E152C105-A133-4D03-BBF8-3D4B2FBA3E2A}"
} as const;

const rootType = {
  contexts: "{8CE74569-9B7D-4993-AFE8-38BB8CE419F5}",
  globals: "{CEE4E889-0249-4D59-9D56-CD4BD159E411}",
  classes: "{7DF455AB-9AB1-4A95-B906-5DB1D1087EBB}",
  ebuses: "{D2B5D77C-09F3-476D-A611-49B0A1B9EDFB}"
} as const;

const fieldNames = [
  "MsgId",
  "request",
  "ackCode",
  "names",
  "methods",
  "properties",
  "classes",
  "EBusses",
  "name",
  "info",
  "isRead",
  "isWrite",
  "type",
  "category",
  "events",
  "canBroadcast",
  "canQueue",
  "hasHandler",
  "element"
];

const fieldNameByCrc = new Map(fieldNames.map((name) => [azCrc32(name), name]));

export function decodeScriptDebugApiDump(payload: Buffer): Partial<O3deLuaApiDump> | undefined {
  const root = parseBinaryObjectStream(payload);
  const value = nodeToValue(root) as Record<string, unknown>;

  if (root.typeId === rootType.contexts) {
    return { contexts: asArray(value.names).map(String) };
  }

  if (root.typeId === rootType.globals) {
    return {
      globals: {
        methods: asArray(value.methods) as never[],
        properties: asArray(value.properties) as never[]
      }
    };
  }

  if (root.typeId === rootType.classes) {
    return { classes: asArray(value.classes) as never[] };
  }

  if (root.typeId === rootType.ebuses) {
    return { ebuses: asArray(value.EBusses) as never[] };
  }

  return undefined;
}

export function parseBinaryObjectStream(payload: Buffer): ObjectStreamNode {
  const reader = new ObjectStreamReader(payload);
  const tag = reader.readUInt8();
  if (tag !== binaryTag) {
    throw new Error(`Unsupported ObjectStream tag 0x${tag.toString(16)}.`);
  }

  const version = reader.readUInt32();
  if (version !== 3) {
    throw new Error(`Unsupported ObjectStream binary version ${version}.`);
  }

  const root = reader.readElement();
  if (!root) {
    throw new Error("ObjectStream does not contain a root element.");
  }

  return root;
}

function nodeToValue(node: ObjectStreamNode): unknown {
  if (node.typeId === typeId.string) {
    return node.value?.toString("utf8") ?? "";
  }

  if (node.typeId === typeId.bool) {
    return (node.value?.[0] ?? 0) !== 0;
  }

  if (node.typeId === typeId.u32) {
    return node.value && node.value.length >= 4 ? node.value.readUInt32BE(0) : 0;
  }

  if (node.typeId === typeId.u64) {
    return node.value && node.value.length >= 8 ? Number(node.value.readBigUInt64BE(0)) : 0;
  }

  if (node.typeId === typeId.uuid) {
    return node.value && node.value.length >= 16 ? formatUuid(node.value.subarray(0, 16)) : "";
  }

  if (node.children.length > 0 && node.children.every((child) => getFieldName(child) === "element")) {
    return node.children.map(nodeToValue);
  }

  const result: Record<string, unknown> = {};
  for (const child of node.children) {
    const fieldName = getFieldName(child);
    const childValue = nodeToValue(child);
    if (shouldFlattenChild(fieldName, childValue)) {
      Object.assign(result, childValue);
      continue;
    }

    const existing = result[fieldName];
    if (existing === undefined) {
      result[fieldName] = childValue;
    } else if (Array.isArray(existing)) {
      existing.push(childValue);
    } else {
      result[fieldName] = [existing, childValue];
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shouldFlattenChild(fieldName: string, value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  if (fieldName === "value") {
    return true;
  }

  const looksLikeScriptUserMethodInfo =
    Object.prototype.hasOwnProperty.call(value, "name") ||
    Object.prototype.hasOwnProperty.call(value, "info") ||
    Object.prototype.hasOwnProperty.call(value, "category");

  return fieldName.startsWith("crc_") && looksLikeScriptUserMethodInfo;
}

function getFieldName(node: ObjectStreamNode): string {
  if (node.nameCrc === undefined) {
    return "value";
  }

  return fieldNameByCrc.get(node.nameCrc) ?? `crc_${node.nameCrc.toString(16).padStart(8, "0")}`;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex").toUpperCase();
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}

class ObjectStreamReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  readElement(): ObjectStreamNode | undefined {
    const flags = this.readUInt8();
    if (flags === elementEnd) {
      return undefined;
    }

    const nameCrc = flags & hasName ? this.readUInt32() : undefined;
    if (flags & hasVersion) {
      this.readUInt8();
    }

    const typeId = formatUuid(this.readBytes(16));
    const value = flags & hasValue ? this.readBytes(this.readValueSize(flags)) : undefined;
    const children: ObjectStreamNode[] = [];

    while (this.offset < this.buffer.length) {
      const child = this.readElement();
      if (!child) {
        break;
      }
      children.push(child);
    }

    return { typeId, nameCrc, value, children };
  }

  readUInt8(): number {
    this.ensure(1);
    return this.buffer.readUInt8(this.offset++);
  }

  readUInt32(): number {
    this.ensure(4);
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  private readBytes(size: number): Buffer {
    this.ensure(size);
    const value = this.buffer.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  private readValueSize(flags: number): number {
    let size = flags & valueSizeMask;
    if (!(flags & extraSizeField)) {
      return size;
    }

    if (size === 1) {
      return this.readUInt8();
    }

    if (size === 2) {
      this.ensure(2);
      const value = this.buffer.readUInt16BE(this.offset);
      this.offset += 2;
      return value;
    }

    if (size === 4) {
      return this.readUInt32();
    }

    throw new Error(`Invalid ObjectStream value size field width ${size}.`);
  }

  private ensure(size: number): void {
    if (this.offset + size > this.buffer.length) {
      throw new Error(`ObjectStream ended early: wanted ${size} bytes, ${this.buffer.length - this.offset} available.`);
    }
  }
}
