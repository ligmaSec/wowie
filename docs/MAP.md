# Map layers, tracked destinations and gathering nodes

The agent can mark your world map. What it draws are **layers**: a named list of points (`uiMapID`, x, y in map percent, a label, a kind), optionally **ordered** (a route: numbered pins joined by lines) and **looping** (a farming circuit).

## How marks get from the agent to the game

1. For every run, whatever the agent, the bridge sets `WOW_AI_MAP_FILE` to a fresh file in `bridge/mapjobs/`. Tools append commands there, one JSON object per line:

   ```json
   {"op":"set","layer":"mining","title":"Copper loop","ordered":true,"loop":true,"points":[{"m":1432,"x":41.5,"y":47.8,"label":"1. Copper Vein","kind":"ore"}]}
   {"op":"clear","layer":"mining"}
   {"op":"clearall"}
   ```

   The agent can also put a few marks in its reply inside a ```` ```wowmap ```` block; the bridge takes the block out of the text. The system prompt that goes with the game context explains both ways, so any agent can draw without extra tooling: `set` replaces a layer, `clear` removes one, `clearall` removes them all; `kind` is one of `ore`, `herb`, `quest`, `turnin`, `kill`, `loot`, `object`, `explore`, `npc`, `trainer`, `vendor`, `dungeon`, `flight`, `poi`.
2. When the run ends the bridge validates the commands (`protocol.js`: sanitized labels, coordinates clamped to 0-100, at most 400 points per layer, 1500 in total, 12 layers with the oldest dropped first), applies them to the layers it keeps in `state.json`, and bumps a version number. The reply gets a `[bridge] map: ...` line saying what changed.
3. The next slot files carry the whole set (`map = { epoch, version, layers }`) for three minutes after a change (on progress publishes only while the set is small), and again after every hello. The addon replaces its copy when the version is newer (or the bridge's state was reset). A mark can't be applied twice, and a client that lost its saved data gets the layers back when it says hello.

## In game

- **World map:** pins for every visible layer on the map you are looking at, projected onto continent maps too. Hover for the label; click to track a destination. A point outside Orgrimmar belongs on Durotar's map, not the city map.
- **Tracked destinations:** the active stop is sent to the game's waypoint tracking, not a separate WoWAI compass. OpenMap follows the native waypoint. With **ShortestPathForever** enabled, its public routing API draws your configured map/minimap route, including dotted paths and directions around terrain. It owns its intermediate waypoint; WoWAI does not overwrite it on each update. Without that routing addon, the game tracks the destination as a native waypoint.
- **Progress and stopping:** new/changed ordered routes and single destinations on your continent activate automatically unless another route is active. Unordered multi-point collections remain map-only. ShortestPathForever decides routed arrival; native-only navigation advances within 12 yards. `next`, `prev` and `stop` update the tracked destination, and loops wrap around. Stop/completion restores prior player tracking only while the addon still owns it; a player-selected pin or quest is not overwritten. Routing requested in combat starts after combat.
- **Herb and ore nodes:** with a `WoWAI_Nodes` data addon installed (see below), every herb and ore spawn point of the zone on the world map, filtered to what your skill can gather.

| Command | Does |
|---|---|
| `/wow-ai map` | List layers, navigation and node settings |
| `/wow-ai map ore [on\|off]`, `/wow-ai map herb [on\|off]` | Show or hide mining / herbalism nodes |
| `/wow-ai map filter all\|skill` | Every node, or only those your skill can gather (default) |
| `/wow-ai map hide <layer>`, `/wow-ai map show <layer>` | Hide or show a layer locally |
| `/wow-ai map nav <layer> [n]`, `next`, `prev`, `stop` | Track a destination, move between stops, or stop the owned route |

`/aimap` is a shorter alias for `/wow-ai map`. Everything here only reads positions and draws. Nothing moves, targets or acts for you.

Activate an already-saved destination with `/aimap nav <layer>`, using the name shown by `/aimap`; for example `/aimap nav nearby-mining`. No new agent request is needed. A stopped destination stays stopped when the bridge resends an unchanged snapshot.

The native integration uses the client's [`C_Map.SetUserWaypoint`](https://github.com/Ketho/wow-ui-source-forever/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/MapDocumentation.lua) and [`C_SuperTrack`](https://github.com/Ketho/wow-ui-source-forever/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/SuperTrackManagerDocumentation.lua) APIs. ShortestPathForever is optional; its v1 API receives one active destination under the owner `WoWAI`, and only that owner's route is cancelled.

## Where the data comes from

The bridge ships no game data: the agent has to know where things are. With just the system prompt it can place marks it knows or that you tell it about. For real routes, point the chat at a folder (`/wow-ai cd`) that holds game data and tools to query it, and describe them in that folder's `CLAUDE.md` (or the equivalent for your agent): quests, NPCs, objects and gathering spawns with their `uiMapID` and coordinates, and a script that appends `set` commands to `$WOW_AI_MAP_FILE`. Such datasets exist (QuestieDB, AtlasLootClassic, the vmangos world database) but their licences don't allow redistributing them here, so that folder stays yours.

The optional `WoWAI_Nodes` addon is the same idea for the in-game node pins: a separate addon that sets the global `WoWAINodes = { kinds = { { name, "mining"|"herbalism", requiredSkill }, ... }, maps = { [uiMapID] = { [kindIndex] = "xxxyyyxxxyyy..." } } }`, where each point is x and y in tenths of a percent, three digits each. `Map.lua` reads it if it is there and says so in `/wow-ai map` if it is not.
