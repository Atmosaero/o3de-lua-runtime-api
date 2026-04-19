import * as net from "net";
import { Buffer } from "node:buffer";
import * as vscode from "vscode";
import { decodeScriptDebugApiDump } from "./objectStreamDecoder";
import { O3deLuaApiDump } from "./o3deApi";
import {
  buildRemoteToolsMessagePackets,
  luaToolsPort,
  packetType,
  parseRemoteToolsConnect,
  parseRemoteToolsMessage,
  TcpPacket,
  TcpPacketFramer
} from "./remoteToolsProtocol";
import {
  buildScriptDebugRequestObjectStream,
  describeObjectStreamPayload,
  scriptDebugRequest
} from "./scriptDebugProtocol";

export interface RemoteToolsHostStatus {
  listening: boolean;
  port: number;
  connections: number;
  lastEndpoint?: string;
  lastPacketType?: number;
}

type ApiPart = "contexts" | "ebuses" | "classes" | "globals";

interface PendingRefresh {
  resolve: (dump: O3deLuaApiDump) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RemoteToolsHost implements vscode.Disposable {
  private server?: net.Server;
  private sockets = new Set<net.Socket>();
  private inboundMessages = new Map<number, { chunks: Buffer[]; received: number; total: number }>();
  private apiDump: O3deLuaApiDump = { version: 1, contexts: [], globals: {}, classes: [], ebuses: [] };
  private receivedApiParts = new Set<ApiPart>();
  private activeSocket?: net.Socket;
  private activePersistentId?: number;
  private pendingRefreshes: PendingRefresh[] = [];
  private lastEndpoint?: string;
  private lastPacketType?: number;
  private output?: vscode.OutputChannel;

  constructor(output?: vscode.OutputChannel) {
    this.output = output;
  }

  getStatus(): RemoteToolsHostStatus {
    return {
      listening: this.server?.listening ?? false,
      port: luaToolsPort,
      connections: this.sockets.size,
      lastEndpoint: this.lastEndpoint,
      lastPacketType: this.lastPacketType
    };
  }

  getApiDump(): O3deLuaApiDump {
    return this.apiDump;
  }

  async refreshApiFromEditor(timeoutMs = 30000): Promise<O3deLuaApiDump> {
    await this.stop();
    await this.start();
    this.resetApiDump();

    const socket = await this.waitForEditorConnection(timeoutMs);
    const persistentId = this.activePersistentId;
    if (!persistentId) {
      throw new Error("O3DE Editor connected, but RemoteToolsConnect has not been received yet.");
    }

    this.requestRuntimeApi(socket, persistentId);
    return this.waitForCompleteApi(timeoutMs);
  }

  async start(port = luaToolsPort): Promise<void> {
    if (this.server?.listening) {
      return;
    }

    this.server = net.createServer((socket) => this.accept(socket));

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };

      this.server?.once("error", onError);
      this.server?.once("listening", onListening);
      this.server?.listen(port, "127.0.0.1");
    });

    this.log(
      `RemoteTools host listening on 127.0.0.1:${port}. Start or restart O3DE Editor to connect. ` +
        "While this host is active, the legacy LuaIDE cannot bind the same port."
    );
    this.log(
      `RemoteTools packet ids: InitiateConnection=${packetType.initiateConnection}, ` +
        `Connect=${packetType.remoteToolsConnect}, Message=${packetType.remoteToolsMessage}.`
    );
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.activeSocket = undefined;
    this.activePersistentId = undefined;

    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = undefined;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    this.log("RemoteTools host stopped.");
  }

  dispose(): void {
    void this.stop();
  }

  private accept(socket: net.Socket): void {
    const framer = new TcpPacketFramer();
    this.sockets.add(socket);
    this.activeSocket = socket;
    this.log(`Editor connected from ${socket.remoteAddress}:${socket.remotePort}.`);

    socket.on("data", (chunk) => {
      try {
        for (const packet of framer.push(chunk)) {
          this.handlePacket(socket, packet);
        }
      } catch (error) {
        this.log(`RemoteTools parse error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    socket.on("close", () => {
      this.sockets.delete(socket);
      if (this.activeSocket === socket) {
        this.activeSocket = undefined;
        this.activePersistentId = undefined;
      }
      this.log("Editor disconnected from RemoteTools host.");
    });

    socket.on("error", (error) => {
      this.log(`RemoteTools socket error: ${error.message}`);
    });
  }

  private handlePacket(socket: net.Socket, packet: TcpPacket): void {
    this.lastPacketType = packet.type;

    if (packet.type === packetType.initiateConnection) {
      this.log(`Received InitiateConnectionPacket (${packet.size} bytes).`);
      return;
    }

    if (packet.type === packetType.remoteToolsConnect) {
      const connect = parseRemoteToolsConnect(packet.payload);
      this.lastEndpoint = `${connect.displayName} (${connect.persistentId})`;
      this.activeSocket = socket;
      this.activePersistentId = connect.persistentId;
      this.log(
        `Received RemoteToolsConnect: displayName="${connect.displayName}", persistentId=${connect.persistentId}, capabilities=${connect.capabilities}.`
      );
      return;
    }

    if (packet.type === packetType.remoteToolsMessage) {
      this.handleRemoteToolsMessage(packet.payload);
      return;
    }

    this.log(`Received packet type ${packet.type} (${packet.size} bytes, flags=${packet.flags}).`);
  }

  private log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.output?.appendLine(line);
    console.log(line);
  }

  private requestRuntimeApi(socket: net.Socket, persistentId: number): void {
    const requests: Array<{ name: string; context?: string; delayMs: number }> = [
      { name: scriptDebugRequest.enumContexts, delayMs: 0 },
      { name: scriptDebugRequest.attachDebugger, context: "Default", delayMs: 100 },
      { name: scriptDebugRequest.enumRegisteredEBuses, context: "Default", delayMs: 200 },
      { name: scriptDebugRequest.enumRegisteredClasses, context: "Default", delayMs: 300 },
      { name: scriptDebugRequest.enumRegisteredGlobals, context: "Default", delayMs: 400 },
      { name: scriptDebugRequest.detachDebugger, context: "Default", delayMs: 500 }
    ];

    for (const request of requests) {
      setTimeout(() => {
        if (socket.destroyed) {
          return;
        }

        const message = buildScriptDebugRequestObjectStream(request.name, request.context ?? "");
        for (const packet of buildRemoteToolsMessagePackets(message, persistentId)) {
          socket.write(packet);
        }
        this.log(`Sent ScriptDebugRequest ${request.name}${request.context ? ` (${request.context})` : ""}.`);
      }, request.delayMs);
    }
  }

  private resetApiDump(): void {
    this.apiDump = { version: 1, contexts: [], globals: {}, classes: [], ebuses: [] };
    this.receivedApiParts.clear();
    this.inboundMessages.clear();
  }

  private handleRemoteToolsMessage(payload: Buffer): void {
    const packet = parseRemoteToolsMessage(payload);
    const existing =
      this.inboundMessages.get(packet.persistentId) ?? { chunks: [], received: 0, total: packet.size };

    if (existing.received === 0) {
      existing.total = packet.size;
    }

    existing.chunks.push(packet.messageBuffer);
    existing.received += packet.messageBuffer.length;

    if (existing.received < existing.total) {
      this.inboundMessages.set(packet.persistentId, existing);
      if (existing.received === packet.messageBuffer.length) {
        this.log(`Receiving fragmented RemoteToolsMessage: ${existing.total} bytes for ${packet.persistentId}.`);
      }
      return;
    }

    this.inboundMessages.delete(packet.persistentId);
    const message = Buffer.concat(existing.chunks, existing.received).subarray(0, existing.total);
    this.log(`Received ${describeObjectStreamPayload(message)} for ${packet.persistentId}.`);
    this.mergeDecodedApi(message);
  }

  private mergeDecodedApi(message: Buffer): void {
    try {
      const decoded = decodeScriptDebugApiDump(message);
      if (!decoded) {
        return;
      }

      const decodedPart = this.getDecodedPart(decoded);
      if (decodedPart) {
        this.receivedApiParts.add(decodedPart);
      }

      this.apiDump = {
        ...this.apiDump,
        ...decoded,
        globals: {
          ...this.apiDump.globals,
          ...decoded.globals
        },
        source: {
          endpoint: this.lastEndpoint,
          context: "Default"
        },
        generatedAt: new Date().toISOString()
      };

      const contexts = this.apiDump.contexts?.length ?? 0;
      const ebuses = this.apiDump.ebuses?.length ?? 0;
      const classes = this.apiDump.classes?.length ?? 0;
      const globalMethods = this.apiDump.globals?.methods?.length ?? 0;
      const globalProperties = this.apiDump.globals?.properties?.length ?? 0;
      this.log(
        `Decoded runtime API: ${contexts} contexts, ${ebuses} EBuses, ${classes} classes, ` +
          `${globalMethods} global methods, ${globalProperties} global properties.`
      );
      this.resolveCompleteRefreshes();
    } catch (error) {
      this.log(`ObjectStream decode error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private getDecodedPart(decoded: Partial<O3deLuaApiDump>): ApiPart | undefined {
    if (Object.prototype.hasOwnProperty.call(decoded, "contexts")) {
      return "contexts";
    }
    if (Object.prototype.hasOwnProperty.call(decoded, "ebuses")) {
      return "ebuses";
    }
    if (Object.prototype.hasOwnProperty.call(decoded, "classes")) {
      return "classes";
    }
    if (Object.prototype.hasOwnProperty.call(decoded, "globals")) {
      return "globals";
    }
    return undefined;
  }

  private hasCompleteApi(): boolean {
    return this.receivedApiParts.has("ebuses") && this.receivedApiParts.has("classes") && this.receivedApiParts.has("globals");
  }

  private waitForCompleteApi(timeoutMs: number): Promise<O3deLuaApiDump> {
    if (this.hasCompleteApi()) {
      return Promise.resolve(this.apiDump);
    }

    return new Promise((resolve, reject) => {
      const pending: PendingRefresh = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingRefreshes = this.pendingRefreshes.filter((item) => item !== pending);
          reject(
            new Error(
              `Timed out waiting for O3DE runtime API. Received: ${[...this.receivedApiParts].sort().join(", ") || "nothing"}.`
            )
          );
        }, timeoutMs)
      };
      this.pendingRefreshes.push(pending);
    });
  }

  private resolveCompleteRefreshes(): void {
    if (!this.hasCompleteApi()) {
      return;
    }

    const pending = this.pendingRefreshes;
    this.pendingRefreshes = [];
    for (const item of pending) {
      clearTimeout(item.timer);
      item.resolve(this.apiDump);
    }
  }

  private waitForEditorConnection(timeoutMs: number): Promise<net.Socket> {
    if (this.activeSocket && this.activePersistentId && !this.activeSocket.destroyed) {
      return Promise.resolve(this.activeSocket);
    }

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (this.activeSocket && this.activePersistentId && !this.activeSocket.destroyed) {
          clearInterval(timer);
          resolve(this.activeSocket);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for O3DE Editor RemoteTools connection. Start or restart the Editor."));
        }
      }, 100);
    });
  }
}
