--- @meta
--- Generated from O3DE runtime-reflected Lua API.
--- Source generated at: 2026-04-18T00:00:00.000Z
--- Source: Editor / Default

-- Globals
---@type any
TickRequestBus = TickRequestBus or nil

Debug = Debug or {}
---@param message any
---@return any
function Debug.Log(message) end

-- Classes
---@class Vector3
Vector3 = Vector3 or {}

---@type any
Vector3.x = Vector3.x or nil

Vector3 = Vector3 or {}
---@return any
function Vector3.CreateOne() end

Vector3 = Vector3 or {}
---@return any
function Vector3.GetLength() end

-- EBuses
---@class TransformBus
TransformBus = TransformBus or {}

---@class TransformBus.Broadcast
TransformBus.Broadcast = TransformBus.Broadcast or {}

---@class TransformBus.Event
TransformBus.Event = TransformBus.Event or {}

TransformBus = TransformBus or {}
TransformBus.Event = TransformBus.Event or {}
---@param entityId any
---@return any
function TransformBus.Event.GetWorldTM(entityId) end

TransformBus = TransformBus or {}
TransformBus.Event = TransformBus.Event or {}
---@param entityId any
---@param transform any
---@return any
function TransformBus.Event.SetWorldTM(entityId, transform) end

TransformBus = TransformBus or {}
TransformBus.Broadcast = TransformBus.Broadcast or {}
---@return any
function TransformBus.Broadcast.GetDefaultScale() end

---@class MyProjectRequestBus
MyProjectRequestBus = MyProjectRequestBus or {}

---@class MyProjectRequestBus.Broadcast
MyProjectRequestBus.Broadcast = MyProjectRequestBus.Broadcast or {}

---@class MyProjectRequestBus.Notification
MyProjectRequestBus.Notification = MyProjectRequestBus.Notification or {}

MyProjectRequestBus = MyProjectRequestBus or {}
MyProjectRequestBus.Broadcast = MyProjectRequestBus.Broadcast or {}
---@param spawnPoint any
---@param count any
---@return any
function MyProjectRequestBus.Broadcast.SpawnSquad(spawnPoint, count) end

MyProjectRequestBus = MyProjectRequestBus or {}
MyProjectRequestBus.Notification = MyProjectRequestBus.Notification or {}
---@param squadId any
---@return any
function MyProjectRequestBus.Notification.OnSquadSpawned(squadId) end

