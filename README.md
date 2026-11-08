# Godot MCP
[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white 'Node.js')](https://nodejs.org/en/download/)
[![](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white 'TypeScript')](https://www.typescriptlang.org/)

[![](https://img.shields.io/github/last-commit/xuxinzhi007/godot-mcp 'Last Commit')](https://github.com/xuxinzhi007/godot-mcp/commits/main)
[![](https://img.shields.io/github/stars/xuxinzhi007/godot-mcp 'Stars')](https://github.com/xuxinzhi007/godot-mcp/stargazers)
[![](https://img.shields.io/github/forks/xuxinzhi007/godot-mcp 'Forks')](https://github.com/xuxinzhi007/godot-mcp/network/members)
[![](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)


```text
                           (((((((             (((((((
                        (((((((((((           (((((((((((
                        (((((((((((((       (((((((((((((
                        (((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((
         (((((      (((((((((((((((((((((((((((((((((((((((((      (((((
       (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
     ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
    ((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
      (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
        (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((@@@@@@@(((((((((((((((((((((((((((@@@@@@@(((((((((((
         (((((((((@@@@,,,,,@@@(((((((((((((((((((((@@@,,,,,@@@@(((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         ((((((((@@@,,,,,,,,,@@(((((((@@@@@(((((((@@,,,,,,,,,@@@((((((((
         (((((((((@@@,,,,,,,@@((((((((@@@@@((((((((@@,,,,,,,@@@(((((((((
         ((((((((((((@@@@@@(((((((((((@@@@@(((((((((((@@@@@@((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
         @@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@((((((((((((@@@@@@@@@@@@@
         ((((((((( @@@(((((((((((@@(((((((((((@@(((((((((((@@@ (((((((((
         (((((((((( @@((((((((((@@@(((((((((((@@@((((((((((@@ ((((((((((
          (((((((((((@@@@@@@@@@@@@@(((((((((((@@@@@@@@@@@@@@(((((((((((
           (((((((((((((((((((((((((((((((((((((((((((((((((((((((((((
              (((((((((((((((((((((((((((((((((((((((((((((((((((((
                 (((((((((((((((((((((((((((((((((((((((((((((((
                        (((((((((((((((((((((((((((((((((


                          /$$      /$$  /$$$$$$  /$$$$$$$
                         | $$$    /$$$ /$$__  $$| $$__  $$
                         | $$$$  /$$$$| $$  \__/| $$  \ $$
                         | $$ $$/$$ $$| $$      | $$$$$$$/
                         | $$  $$$| $$| $$      | $$____/
                         | $$\  $ | $$| $$    $$| $$
                         | $$ \/  | $$|  $$$$$$/| $$
                         |__/     |__/ \______/ |__/
```

A Model Context Protocol (MCP) server for interacting with the Godot game engine.

## Introduction

Godot MCP enables AI agents to launch the Godot editor, run projects, capture debug output, and control project execution. This direct feedback loop helps agents understand what works and what doesn't in real Godot projects, leading to better code generation and debugging assistance.

## Features

A complete agent loop: **see → edit → verify → run → observe**.

- **See**: `read_scene` returns the whole node tree with typed property values; `read_file` / `list_files` read scripts, scenes and resources; `scene_structure` reports inherited bases, instanced sub-scenes and UIDs before you touch anything.
- **Edit**: create scenes, add/modify/remove nodes, rename, attach GDScript, assign textures, save variants — with JSON-friendly property values (`[x,y]` or `{"x":..,"y":..}` for Vector2, `"#ff0000"` for Color, `"res://..."` for resources).
- **Verify**: `validate_script` parse-checks GDScript through the engine and reports file:line errors (autoload false positives are filtered out).
- **Run**: `run_project` with `headless` + `quitAfter` for scripted verification runs, or `run_script` for one-off headless GDScript tools.
- **Observe**: `get_debug_output` keeps stdin/stdout/stderr **after the process exits**, with incremental (`since`) and `clear` paging, plus exit codes and GDScript backtraces.
- **Fail loudly**: every engine operation returns an exit code and an explicit `[ERROR]` contract, so a rejected property or a failed save can never be reported as success.

### Tools (26)

| Area | Tools |
|---|---|
| Project | `get_godot_version`, `list_projects`, `get_project_info`, `read_project_settings`, `list_files`, `read_file`, `write_file`, `delete_file` |
| Scenes (read) | `read_scene`, `scene_structure` |
| Scenes (write) | `create_scene`, `add_node`, `modify_node`, `remove_node`, `attach_script`, `load_sprite`, `save_scene`, `export_mesh_library` |
| Resources / UID | `get_uid`, `update_project_uids` |
| Scripts | `validate_script`, `run_script` |
| Run / debug | `launch_editor`, `run_project`, `get_debug_output`, `stop_project` |

### Safety model

- Every path is resolved inside the project; `..` and absolute paths are rejected.
- `write_file` / `delete_file` back the previous content up to `.godot/mcp_backups/` (git-ignored by default) before changing anything.
- Scenes whose **root** is an instance of another scene (inherited scenes) are refused, because re-packing would copy the base scene inline. Pass `force: true` to accept that.
- Scenes that merely contain instanced sub-scenes are allowed (Godot preserves `scene_file_path` on re-pack) but return a warning, since the whole file is rewritten.
- Property writes that the engine silently drops are reported as failures with the requested value, instead of pretending they worked.

### Tool result contract

The bundled GDScript exits non-zero and prints `[ERROR] ...` on any failure, and prints exactly one `[RESULT]<json>` line on success. The server treats a non-zero exit code **or** an `[ERROR]` line as a failure, so an agent can trust `isError`.


## Requirements

- [Godot Engine](https://godotengine.org/download) installed on your system
- Node.js (>=18.0.0) and npm
- An AI agent that supports MCP

## Quick Start

### Claude Code

```bash
claude mcp add godot -- npx @coding-solo/godot-mcp
```

That's it. Restart Claude Code and your Godot MCP tools are available.

With environment variables:

```bash
claude mcp add godot -e GODOT_PATH=/path/to/godot -e DEBUG=true -- npx @coding-solo/godot-mcp
```

<details>
<summary><strong>Cline</strong></summary>

Add to your Cline MCP settings file (`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "DEBUG": "true"
      },
      "disabled": false,
      "autoApprove": [
        "launch_editor",
        "run_project",
        "get_debug_output",
        "stop_project",
        "get_godot_version",
        "list_projects",
        "get_project_info",
        "create_scene",
        "add_node",
        "load_sprite",
        "export_mesh_library",
        "save_scene",
        "get_uid",
        "update_project_uids"
      ]
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

**Using the Cursor UI:**

1. Go to **Cursor Settings** > **Features** > **MCP**
2. Click on the **+ Add New MCP Server** button
3. Fill out the form:
   - Name: `godot`
   - Type: `command`
   - Command: `npx @coding-solo/godot-mcp`
4. Click "Add"
5. You may need to press the refresh button in the top right corner of the MCP server card to populate the tool list

**Using Project-Specific Configuration:**

Create a file at `.cursor/mcp.json` in your project directory:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Other MCP Clients</strong></summary>

For any MCP-compatible client, use this configuration:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["@coding-solo/godot-mcp"],
      "env": {
        "GODOT_PATH": "/path/to/godot",
        "DEBUG": "true"
      }
    }
  }
}
```

</details>

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GODOT_PATH` | Path to the Godot executable (overrides automatic detection) |
| `DEBUG` | Set to `"true"` to enable detailed server-side debug logging (stderr) |
| `GODOT_DEBUG` | Set to `"true"` to pass `--debug-godot` to the operations script (very verbose) |
| `GODOT_OP_TIMEOUT_MS` | Timeout for a single engine operation (default `180000`) |

<details>
<summary><strong>Building from Source</strong></summary>

```bash
git clone https://github.com/xuxinzhi007/godot-mcp.git
cd godot-mcp
npm install
npm run build
```

Then point your MCP client to `build/index.js` instead of using `npx`.

Smoke-test the server without a client (needs `GODOT_PATH` for engine-backed steps):

```bash
GODOT_PATH=/path/to/godot npm run probe:smoke
# or replay your own plan:  npm run probe -- my-plan.json
```

`scripts/probe.mjs` speaks MCP over stdio and prints PASS/FAIL per step, which is handy for verifying behaviour against a real project.

</details>


## Architecture

```text
MCP client (stdio)
  └─ TypeScript server (src/index.ts)
       ├─ file tools        → plain fs access, project-scoped
       ├─ verification      → godot --check-only --script <file>
       ├─ run/debug         → child process + retained log buffer
       └─ scene/resource ops → godot --headless --script godot_operations.gd <op> <json>
```

The bundled `src/scripts/godot_operations.gd` is a single `SceneTree` entry point that dispatches JSON operations. It is used only for work that needs the engine (scene packing, resource saving, UID lookup); everything else is plain filesystem access so it stays fast.

Why a script instead of an editor plugin: this keeps the server usable in headless / CI environments. The trade-off is that scene edits re-pack the file, which is why the structural safety checks above exist.


## Troubleshooting

- **Godot Not Found**: Set the `GODOT_PATH` environment variable to your Godot executable path
- **Connection Issues**: Ensure the server is running and restart your AI assistant
- **Invalid Project Path**: Ensure the path points to a directory containing a `project.godot` file
- **Build Issues**: Make sure all dependencies are installed by running `npm install`

<details>
<summary><strong>Cursor-Specific Issues</strong></summary>

- Ensure the MCP server shows up and is enabled in Cursor settings (Settings > MCP)
- MCP tools can only be run using the Agent chat profile (Cursor Pro or Business subscription)
- Use "Yolo Mode" to automatically run MCP tool requests

</details>

## Credits

Originally based on [Coding-Solo/godot-mcp](https://github.com/Coding-Solo/godot-mcp) (MIT).
This fork rewrites the operation protocol (v2), adds scene reading, reference-aware file moves, script validation, headless runs and a retained debug log.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
