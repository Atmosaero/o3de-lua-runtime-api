# O3DE Lua Runtime API

Experimental VS Code extension for generating LuaLS stubs from O3DE runtime-reflected Lua APIs.

The extension connects to a running O3DE Editor through RemoteTools, reads the same runtime-reflected Lua API data
used by the legacy Lua tools, and writes a LuaLS stub file for autocomplete.

Static Gem scanning is intentionally not used as the source of truth because project custom EBuses only exist
reliably in the loaded runtime `BehaviorContext`.

## Status

This extension is alpha-quality. It is useful for testing O3DE Lua autocomplete, but the RemoteTools bridge and type
inference still need hardening before marketplace publication.

## Commands

- `O3DE Lua: Refresh API From O3DE Editor`

The status bar item `O3DE Lua API` runs the same command.

## Usage

1. Open an O3DE project workspace in VS Code.
2. Run `O3DE Lua: Refresh API From O3DE Editor`.
3. Start or restart O3DE Editor when the extension begins listening.
4. Wait for the generated stub summary.
5. Run `Lua: Restart Language Server` if LuaLS does not pick up the new library immediately.

## RemoteTools prototype

`O3DE Lua: Refresh API From O3DE Editor` opens `127.0.0.1:6777`, the same Lua RemoteTools port used by the old
LuaIDE. Start or restart the O3DE Editor after the host is listening. The `O3DE Lua RemoteTools` output channel logs
AzNetworking TCP packets and `RemoteToolsConnect` from the Editor.

Only one host can bind this port. While the extension host is running, the legacy LuaIDE cannot accept the same
RemoteTools connection. A later version should either bind only during API refresh and release the port afterward,
or act as a small proxy so LuaIDE can still receive debugger traffic.

This is the first layer of the direct VS Code-to-Editor path. The next layer is the O3DE `ObjectStream` binary codec
for `ScriptDebugRequest` and the `ScriptDebugRegistered*Result` messages.

The refresh command runs the direct path end to end: it starts the RemoteTools host if needed, waits for the Editor
connection, requests contexts, EBuses, classes, and globals from the runtime, then writes the LuaLS stub file.

By default the generated stub is stored in VS Code extension global storage, not in the O3DE project. This keeps
`o3de-lua-api.lua` outside Asset Processor source scanning while still adding the file to `Lua.workspace.library`.
Set `o3deLua.stubOutputPath` only when you explicitly want to override that storage location.

## Limitations

- The extension currently owns the Lua RemoteTools port while refreshing, so the legacy LuaIDE cannot use the same
  connection at that moment.
- Some EBus return types are inferred from naming conventions because RemoteTools does not always include return
  type metadata for EBus events.
- Lua component instance fields may still need local `---@class` / `---@field` annotations when LuaLS cannot infer
  project script table shapes.

## Development

```powershell
npm install
npm run compile
```
