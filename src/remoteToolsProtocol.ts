import { Buffer } from "node:buffer";

export const luaToolsPort = 6777;
export const luaToolsName = "LuaRemoteTools";
export const remoteToolsBufferSize = 16384;

export const packetType = {
  initiateConnection: 1,
  connectionHandshake: 2,
  terminateConnection: 3,
  heartbeat: 4,
  fragmented: 5,
  remoteToolsConnect: 7,
  remoteToolsMessage: 8
} as const;

export interface TcpPacket {
  flags: number;
  type: number;
  size: number;
  payload: Buffer;
}

export interface RemoteToolsConnectPacket {
  capabilities: number;
  persistentId: number;
  displayName: string;
}

export interface RemoteToolsMessagePacket {
  messageBuffer: Buffer;
  size: number;
  persistentId: number;
}

export class NetworkReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  readUInt8(): number {
    this.ensure(1);
    return this.buffer.readUInt8(this.offset++);
  }

  readUInt16(): number {
    this.ensure(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  readUInt32(): number {
    this.ensure(4);
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readBytes(size: number): Buffer {
    this.ensure(size);
    const value = this.buffer.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  readBoundedUInt(maxValue: number): number {
    if (maxValue <= 0xff) {
      return this.readUInt8();
    }

    if (maxValue <= 0xffff) {
      return this.readUInt16();
    }

    return this.readUInt32();
  }

  readAzString(): string {
    const size = this.readUInt32();
    const outSize = this.readBoundedUInt(size);
    if (outSize !== size) {
      throw new Error(`Invalid AZStd::string size: declared ${size}, serialized ${outSize}.`);
    }

    return this.readBytes(size).toString("utf8");
  }

  private ensure(size: number): void {
    if (this.remaining < size) {
      throw new Error(`RemoteTools packet ended early: wanted ${size} bytes, ${this.remaining} available.`);
    }
  }
}

export class TcpPacketFramer {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): TcpPacket[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const packets: TcpPacket[] = [];

    while (this.buffer.length >= 5) {
      const flags = this.buffer.readUInt8(0);
      const type = this.buffer.readUInt16BE(1);
      const size = this.buffer.readUInt16BE(3);
      const fullSize = 5 + size;

      if (this.buffer.length < fullSize) {
        break;
      }

      packets.push({
        flags,
        type,
        size,
        payload: this.buffer.subarray(5, fullSize)
      });
      this.buffer = this.buffer.subarray(fullSize);
    }

    return packets;
  }
}

export function parseRemoteToolsConnect(payload: Buffer): RemoteToolsConnectPacket {
  const reader = new NetworkReader(payload);
  const packet = {
    capabilities: reader.readUInt32(),
    persistentId: reader.readUInt32(),
    displayName: reader.readAzString()
  };

  if (reader.remaining !== 0) {
    throw new Error(`RemoteToolsConnect has ${reader.remaining} trailing bytes.`);
  }

  return packet;
}

export function parseRemoteToolsMessage(payload: Buffer): RemoteToolsMessagePacket {
  const reader = new NetworkReader(payload);
  const chunkSize = reader.readUInt16();
  const outSize = reader.readUInt16();
  if (outSize !== chunkSize) {
    throw new Error(`Invalid RemoteToolsMessageBuffer size: declared ${chunkSize}, serialized ${outSize}.`);
  }

  const packet = {
    messageBuffer: reader.readBytes(chunkSize),
    size: reader.readUInt32(),
    persistentId: reader.readUInt32()
  };

  if (reader.remaining !== 0) {
    throw new Error(`RemoteToolsMessage has ${reader.remaining} trailing bytes.`);
  }

  return packet;
}

export function buildRemoteToolsMessagePackets(message: Buffer, persistentId: number): Buffer[] {
  const packets: Buffer[] = [];

  for (let offset = 0; offset < message.length; offset += remoteToolsBufferSize) {
    const chunk = message.subarray(offset, Math.min(offset + remoteToolsBufferSize, message.length));
    const payload = Buffer.alloc(2 + 2 + chunk.length + 4 + 4);
    let payloadOffset = 0;
    payload.writeUInt16BE(chunk.length, payloadOffset);
    payloadOffset += 2;
    payload.writeUInt16BE(chunk.length, payloadOffset);
    payloadOffset += 2;
    chunk.copy(payload, payloadOffset);
    payloadOffset += chunk.length;
    payload.writeUInt32BE(message.length, payloadOffset);
    payloadOffset += 4;
    payload.writeUInt32BE(persistentId >>> 0, payloadOffset);

    packets.push(buildTcpPacket(packetType.remoteToolsMessage, payload));
  }

  return packets;
}

export function buildTcpPacket(type: number, payload: Buffer): Buffer {
  if (payload.length > 0xffff) {
    throw new Error(`RemoteTools TCP packet payload is too large: ${payload.length} bytes.`);
  }

  const packet = Buffer.alloc(5 + payload.length);
  packet.writeUInt8(0, 0);
  packet.writeUInt16BE(type, 1);
  packet.writeUInt16BE(payload.length, 3);
  payload.copy(packet, 5);
  return packet;
}
