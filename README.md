# O3DE Lua Runtime API

VS Code extension for generating LuaLS stubs from O3DE runtime-reflected Lua APIs.

The extension connects to a running O3DE Editor through RemoteTools, reads the same runtime-reflected Lua API data
used by the legacy Lua tools, and writes a LuaLS stub file for autocomplete.

Static Gem scanning is intentionally not used as the source of truth because project custom EBuses only exist
reliably in the loaded runtime `BehaviorContext`.

## Commands

- `O3DE Lua: Refresh API From O3DE Editor`

The status bar item `O3DE Lua API` runs the same command.

## Usage

1. Open an O3DE project workspace in VS Code.
2. Start O3DE Editor.
3. Run `O3DE Lua: Refresh API From O3DE Editor`.
4. Wait for the generated stub summary.
5. Run `Lua: Restart Language Server` if LuaLS does not pick up the new library immediately.

## Development

```powershell
npm install
npm run compile
```
