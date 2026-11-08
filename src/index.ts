#!/usr/bin/env node
/**
 * Godot MCP Server — v0.2.0
 *
 * Goals of this version (vs 0.1.x):
 *   - Failures are reported as failures (exit code + explicit [ERROR] contract).
 *   - The agent can *see* a scene before editing it (read_scene / read_file).
 *   - Editing is explicit and guarded (refuses to flatten instanced sub-scenes).
 *   - Run/debug output survives the game exiting (incremental log buffer).
 *   - File-level read/write, script validation and headless runs form a full
 *     edit -> verify -> run -> observe loop.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, resolve, relative, isAbsolute, normalize, sep } from 'path';
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  renameSync,
  statSync,
} from 'fs';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { homedir } from 'os';
import { promisify } from 'util';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVER_VERSION = '0.2.0';
const PROTOCOL_VERSION = 2;
const DEBUG_MODE = process.env.DEBUG === 'true';
const GODOT_DEBUG_MODE = process.env.GODOT_DEBUG === 'true';
const OPERATION_TIMEOUT_MS = Number(process.env.GODOT_OP_TIMEOUT_MS ?? 180_000);
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_LOG_LINES = 20_000;
const MAX_READ_BYTES = 400_000;

const SKIP_DIRS = new Set(['.godot', '.git', 'node_modules', '.import', '.mono', 'bin', 'obj']);

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string, hints: string[] = []): ToolResult {
  const parts = [message.trim()];
  if (hints.length > 0) parts.push('\nHints:\n- ' + hints.join('\n- '));
  return { content: [{ type: 'text', text: parts.join('\n') }], isError: true };
}

class ToolError extends Error {
  hints: string[];
  constructor(message: string, hints: string[] = []) {
    super(message);
    this.name = 'ToolError';
    this.hints = hints;
  }
}

function logDebug(message: string): void {
  if (DEBUG_MODE) console.error(`[DEBUG] ${message}`);
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<ProcResult> {
  const timeoutMs = options.timeoutMs ?? OPERATION_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '', timedOut: false };
  } catch (error: unknown) {
    const err = error as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
    const timedOut = err.killed === true || err.signal === 'SIGTERM';
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? (timedOut ? `Timed out after ${timeoutMs}ms` : err.message ?? ''),
      timedOut,
    };
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

/** Pulls the single "[RESULT]<json>" line out of stdout. */
function parseOperationOutput(stdout: string): { result: unknown; info: string[] } {
  let result: unknown;
  const info: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[RESULT]')) {
      try {
        result = JSON.parse(trimmed.slice('[RESULT]'.length));
      } catch {
        info.push(`Unparseable result line: ${trimmed.slice(0, 200)}`);
      }
    } else if (trimmed.startsWith('[INFO]') || trimmed.startsWith('[DEBUG]')) {
      info.push(trimmed);
    } else {
      info.push(trimmed);
    }
  }
  return { result, info };
}

function extractOperationErrors(stderr: string): string[] {
  const errors: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[ERROR]')) {
      errors.push(trimmed.slice('[ERROR]'.length).trim());
    }
  }
  return errors;
}

/** Splits Godot's stderr into error blocks, warning blocks and everything else.
 *  Continuation lines (indented `at:`, `GDScript backtrace`, frame lines) are
 *  kept attached to the entry they belong to, so a block reads as a unit. */
function classifyStderr(lines: string[]): { errors: string[]; warnings: string[]; other: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const other: string[] = [];
  let current: 'error' | 'warning' | null = null;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed.trim()) continue;
    const isContinuation = /^\s+/.test(trimmed) || /^\s*\[\d+\]\s/.test(trimmed) || trimmed.startsWith('GDScript backtrace');

    if (!isContinuation && /^(ERROR|SCRIPT ERROR):/.test(trimmed)) {
      errors.push(trimmed);
      current = 'error';
      continue;
    }
    if (!isContinuation && trimmed.startsWith('WARNING:')) {
      warnings.push(trimmed);
      current = 'warning';
      continue;
    }
    if (isContinuation && current !== null) {
      (current === 'error' ? errors : warnings).push(trimmed);
      continue;
    }
    other.push(trimmed);
    current = null;
  }
  return { errors, warnings, other };
}

/** Godot's own runtime complaints, useful when the operation script itself blew up. */
function extractEngineErrors(stderr: string): string[] {
  const interesting: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith('SCRIPT ERROR:') ||
      trimmed.startsWith('ERROR:') ||
      trimmed.startsWith('Parse Error:') ||
      trimmed.startsWith('WARNING:')
    ) {
      interesting.push(trimmed);
    }
    if (interesting.length >= 12) break;
  }
  return interesting;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function countProjectFiles(projectPath: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '(none)';
        counts[ext] = (counts[ext] ?? 0) + 1;
      }
    }
  };
  walk(projectPath, 0);
  return counts;
}

/** Minimal project.godot reader: returns { section: { key: rawValue } }. */
function parseGodotSettings(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let current = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1).trim();
      sections[current] = sections[current] ?? {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1 || !current) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    sections[current][key] = value;
  }
  return sections;
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

function settingsToAutoloadNames(sections: Record<string, Record<string, string>>): string[] {
  const autoload = sections['autoload'] ?? {};
  return Object.keys(autoload);
}

function detectEngineVersion(sections: Record<string, Record<string, string>>): string | null {
  const features = sections['application']?.['config/features'];
  if (!features) return null;
  const match = features.match(/"(\d+\.\d+)"/);
  return match ? match[1] : null;
}

function majorMinor(version: string): string | null {
  const match = version.match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : null;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const PROJECT_PATH = {
  type: 'string',
  description: 'Absolute path to the Godot project directory (the one containing project.godot)',
} as const;

const SCENE_PATH = {
  type: 'string',
  description: "Scene file path, project-relative, e.g. 'Scenes/Main.tscn' (res:// prefix optional)",
} as const;

const FORCE = {
  type: 'boolean',
  description:
    'Override the structural safety check. Scenes with instanced sub-scenes or inherited bases are flattened by re-packing, so the server refuses unless force=true.',
} as const;

const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ---- read-only: project ----
  {
    name: 'get_godot_version',
    description: 'Get the installed Godot version',
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_projects',
    description: 'Find Godot projects (directories containing project.godot) in a directory',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory to search' },
        recursive: { type: 'boolean', description: 'Search subdirectories recursively (default false)' },
        maxDepth: { type: 'number', description: 'Maximum recursion depth (default 4)' },
      },
      required: ['directory'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_project_info',
    description:
      'Get project metadata: name, engine version, main scene, autoloads, file counts, and whether the configured Godot binary matches the project version.',
    inputSchema: {
      type: 'object',
      properties: { projectPath: PROJECT_PATH },
      required: ['projectPath'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_project_settings',
    description: 'Parse project.godot into JSON (sections -> key/value) plus derived fields (autoloads, main scene, engine version)',
    inputSchema: {
      type: 'object',
      properties: { projectPath: PROJECT_PATH, sections: { type: 'array', items: { type: 'string' }, description: 'Optional section filter' } },
      required: ['projectPath'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_files',
    description: 'List project files (skips .godot/.git/node_modules), optionally filtered by extension or directory',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        directory: { type: 'string', description: "Restrict to this project-relative directory, e.g. 'Scripts/world'" },
        extensions: { type: 'array', items: { type: 'string' }, description: "Filter by extension, e.g. ['gd','tscn']" },
        limit: { type: 'number', description: 'Maximum files to return (default 400)' },
      },
      required: ['projectPath'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_file',
    description: 'Read a text file inside the project (script, scene, resource, .cfg)',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        filePath: { type: 'string', description: "Project-relative file path, e.g. 'Scripts/player.gd'" },
        maxBytes: { type: 'number', description: 'Maximum bytes to return (default 400000)' },
      },
      required: ['projectPath', 'filePath'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file inside the project. Previous content is backed up under .godot/mcp_backups/ unless backup=false.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        filePath: { type: 'string', description: 'Project-relative file path' },
        content: { type: 'string', description: 'Full file content' },
        backup: { type: 'boolean', description: 'Back up the previous content (default true)' },
      },
      required: ['projectPath', 'filePath', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file inside the project (backed up under .godot/mcp_backups/ unless backup=false)',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        filePath: { type: 'string', description: 'Project-relative file path' },
        backup: { type: 'boolean', description: 'Back up before deleting (default true)' },
      },
      required: ['projectPath', 'filePath'],
    },
  },

  {
    name: 'move_file',
    description:
      'Move or rename a file inside the project. Moves the .import and .uid sidecars too and, unless updateReferences=false, rewrites every res:// reference in scenes/resources/scripts.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        from: { type: 'string', description: 'Existing project-relative path' },
        to: { type: 'string', description: 'New project-relative path' },
        updateReferences: { type: 'boolean', description: 'Rewrite res:// references to the new path (default true)' },
        overwrite: { type: 'boolean', description: 'Replace the destination if it exists (default false)' },
      },
      required: ['projectPath', 'from', 'to'],
    },
  },
  {
    name: 'rewrite_references',
    description:
      'Rewrite res:// references from one project path to another without touching files. Use after converting an asset (e.g. .png -> .webp) or to repair references.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        fromPath: { type: 'string', description: 'Old project-relative path' },
        toPath: { type: 'string', description: 'New project-relative path' },
        dryRun: { type: 'boolean', description: 'Only report what would change (default false)' },
      },
      required: ['projectPath', 'fromPath', 'toPath'],
    },
  },
  {
    name: 'find_references',
    description: 'Find every scene/resource/script that references a file (by res:// path, bare path or UID). Run this before moving or deleting anything.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        filePath: { type: 'string', description: 'Project-relative file path to look up' },
      },
      required: ['projectPath', 'filePath'],
    },
    annotations: { readOnlyHint: true },
  },

  // ---- read-only: scenes ----
  {
    name: 'read_scene',
    description:
      'Read a scene as a JSON node tree: path, name, type, owner, instanced-sub-scene info and (optionally) all serialized properties. Never modifies the file.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        scenePath: SCENE_PATH,
        nodePath: { type: 'string', description: "Only return this subtree, e.g. 'BruteRoot' (default: whole scene)" },
        includeProperties: { type: 'boolean', description: 'Include serialized property values (default true)' },
        maxNodes: { type: 'number', description: 'Maximum nodes to return (default 800)' },
      },
      required: ['projectPath', 'scenePath'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'scene_structure',
    description:
      'Cheap structural report for a scene: inherited base, instanced sub-scenes, ext/sub resource counts, uid, and whether it is safe to rewrite.',
    inputSchema: {
      type: 'object',
      properties: { projectPath: PROJECT_PATH, scenePath: SCENE_PATH },
      required: ['projectPath', 'scenePath'],
    },
    annotations: { readOnlyHint: true },
  },

  // ---- scene writes ----
  {
    name: 'create_scene',
    description: 'Create a new .tscn with the given root node type',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        scenePath: SCENE_PATH,
        rootNodeType: { type: 'string', description: "Root node type, e.g. 'Node2D', 'Node3D', 'Control' (default Node2D)" },
        rootNodeName: { type: 'string', description: "Root node name (default 'root')" },
        properties: { type: 'object', description: 'Properties to set on the root node' },
        overwrite: { type: 'boolean', description: 'Replace an existing file (default false)' },
      },
      required: ['projectPath', 'scenePath'],
    },
  },
  {
    name: 'add_node',
    description:
      'Add a node to an existing scene. Property values accept JSON forms: [x,y] or {"x":..,"y":..} for Vector2, "#ff0000" or [r,g,b,a] for Color, "res://..." for resources.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        scenePath: SCENE_PATH,
        nodeType: { type: 'string', description: "Node type, e.g. 'Sprite2D', 'Marker2D', 'Area2D'" },
        nodeName: { type: 'string', description: 'Unique node name under the parent' },
        parentNodePath: { type: 'string', description: "Parent node path, e.g. 'root' or 'root/BruteRoot' (default root)" },
        properties: { type: 'object', description: 'Properties to set on the new node' },
        force: FORCE,
      },
      required: ['projectPath', 'scenePath', 'nodeType', 'nodeName'],
    },
  },
  {
    name: 'modify_node',
    description: 'Set properties on, and/or rename, an existing node in a scene. Reports exactly which properties were rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        scenePath: SCENE_PATH,
        nodePath: { type: 'string', description: "Node path, e.g. 'root/BruteRoot/BodySprite'" },
        properties: { type: 'object', description: 'Properties to set' },
        newName: { type: 'string', description: 'Optional new node name' },
        force: FORCE,
      },
      required: ['projectPath', 'scenePath', 'nodePath'],
    },
  },
  {
    name: 'remove_node',
    description: 'Remove a node (and optionally its subtree) from a scene',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        scenePath: SCENE_PATH,
        nodePath: { type: 'string', description: 'Node path to remove' },
        recursive: { type: 'boolean', description: 'Allow removing a node that has children (default false)' },
        force: FORCE,
      },
      required: ['projectPath', 'scenePath', 'nodePath'],
    },
  },
  {
    name: 'attach_script',
    description: 'Attach an existing .gd script to a node in a scene (fails if the engine refuses the base class)',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        scenePath: SCENE_PATH,
        nodePath: { type: 'string', description: "Target node path (default 'root')" },
        scriptPath: { type: 'string', description: "Project-relative script path, e.g. 'Scripts/player.gd'" },
        force: FORCE,
      },
      required: ['projectPath', 'scenePath', 'scriptPath'],
    },
  },
  {
    name: 'load_sprite',
    description: 'Assign a texture to a Sprite2D / Sprite3D / TextureRect / TextureButton node in a scene',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        scenePath: SCENE_PATH,
        nodePath: { type: 'string', description: "Sprite node path, e.g. 'root/BruteRoot/BodySprite'" },
        texturePath: { type: 'string', description: "Project-relative texture path, e.g. 'Assets/hero.png'" },
        force: FORCE,
      },
      required: ['projectPath', 'scenePath', 'nodePath', 'texturePath'],
    },
  },
  {
    name: 'save_scene',
    description: 'Re-save a scene, or copy it to a new path (scene variant)',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        scenePath: SCENE_PATH,
        newPath: { type: 'string', description: 'Optional target path for a variant copy' },
        overwrite: { type: 'boolean', description: 'Overwrite the new path if it exists (default false)' },
      },
      required: ['projectPath', 'scenePath'],
    },
  },
  {
    name: 'export_mesh_library',
    description: 'Export a 3D scene as a MeshLibrary resource (for GridMap). Fails loudly if the scene has no meshes.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        scenePath: SCENE_PATH,
        outputPath: { type: 'string', description: "Output .res path, e.g. 'resources/tiles.res'" },
        meshItemNames: { type: 'array', items: { type: 'string' }, description: 'Only include these top-level node names (default: all)' },
      },
      required: ['projectPath', 'scenePath', 'outputPath'],
    },
  },
  {
    name: 'get_uid',
    description: 'Get the UID of a file: .uid sidecar (scripts/shaders) or uid="uid://..." header (scenes/resources, Godot 4.4+)',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        filePath: { type: 'string', description: 'Project-relative file path' },
      },
      required: ['projectPath', 'filePath'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'update_project_uids',
    description:
      'Re-save every resource and script so Godot rewrites/creates UID references. Destructive to file formatting — run with dryRun first.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        dryRun: { type: 'boolean', description: 'Only report what would be touched (default false)' },
      },
      required: ['projectPath'],
    },
  },

  // ---- scripts / verification ----
  {
    name: 'validate_script',
    description:
      'Parse-check GDScript files with the engine (--check-only). Autoload identifier false positives are filtered out. Returns per-file errors with line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        filePath: { type: 'string', description: 'Single project-relative .gd file' },
        files: { type: 'array', items: { type: 'string' }, description: 'Several .gd files' },
      },
      required: ['projectPath'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'run_script',
    description:
      'Run a project GDScript headlessly (extends SceneTree or MainLoop). Useful for migrations, data generation and custom test runners.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        scriptPath: { type: 'string', description: "Project-relative .gd script, e.g. 'tools/dump_stats.gd'" },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra user args (passed after --)' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 120000)' },
      },
      required: ['projectPath', 'scriptPath'],
    },
  },

  // ---- run / debug ----
  {
    name: 'launch_editor',
    description: 'Launch the Godot editor for a project (returns immediately)',
    inputSchema: {
      type: 'object',
      properties: { projectPath: PROJECT_PATH },
      required: ['projectPath'],
    },
  },
  {
    name: 'run_project',
    description:
      'Run the project (or a scene) and stream its output into the log buffer. Supports headless mode and --quit-after for scripted verification runs.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        scene: { type: 'string', description: 'Optional scene to run instead of the main scene' },
        headless: { type: 'boolean', description: 'Run with --headless (default false)' },
        quitAfter: { type: 'number', description: 'Exit after N frames (maps to --quit-after)' },
        debugBuild: { type: 'boolean', description: 'Use the debug build (-d)' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra user args (passed after --)' },
        waitMs: { type: 'number', description: 'Wait this long for first output before returning (default 250)' },
      },
      required: ['projectPath'],
    },
  },
  {
    name: 'get_debug_output',
    description:
      'Read captured stdout/stderr of the last run. Output is kept after the process exits. Godot writes warnings to stderr too, so pass severity to separate real errors from warning noise. Use since/clear to page through it.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Start at this output line index (from a previous nextIndex)' },
        tail: { type: 'number', description: 'Return only the last N lines (default 200)' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading (default false)' },
        includeErrors: { type: 'boolean', description: 'Include the stderr stream (default true)' },
        severity: {
          type: 'string',
          enum: ['all', 'errors', 'warnings'],
          description:
            'all (default) returns every stderr line as before; errors returns only ERROR:/SCRIPT ERROR: blocks with their backtraces; warnings returns only WARNING: blocks',
        },
      },
      required: [],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_editor_log',
    description:
      "Read the Godot editor's own log (user://logs/godot.log). This is the only way to see errors from a run you started inside the editor with F5, because that process writes to the editor's output panel instead of to this server.",
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: PROJECT_PATH,
        logPath: { type: 'string', description: 'Explicit log file path (overrides the automatic lookup)' },
        tail: { type: 'number', description: 'Return only the last N lines of each section (default 200)' },
        severity: {
          type: 'string',
          enum: ['all', 'errors', 'warnings'],
          description: 'all (default) returns errors, warnings and plain prints; errors/warnings filters',
        },
      },
      required: ['projectPath'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'stop_project',
    description: 'Stop the running project and return the final output. Safe to call when nothing is running.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

interface RunState {
  child: ChildProcess | null;
  running: boolean;
  exitCode: number | null;
  output: string[];
  errors: string[];
  droppedOutput: number;
  droppedErrors: number;
  projectPath: string;
  startedAt: number;
  endedAt: number | null;
}

class GodotServer {
  private server: Server;
  private godotPath: string | null = null;
  private operationsScriptPath: string;
  private validatedPaths = new Map<string, boolean>();
  private run: RunState = {
    child: null,
    running: false,
    exitCode: null,
    output: [],
    errors: [],
    droppedOutput: 0,
    droppedErrors: 0,
    projectPath: '',
    startedAt: 0,
    endedAt: null,
  };

  constructor() {
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    logDebug(`operations script: ${this.operationsScriptPath}`);

    this.server = new Server(
      { name: 'godot-mcp', version: SERVER_VERSION },
      { capabilities: { tools: {} } }
    );
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    this.setupToolHandlers();

    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  // -- lifecycle ------------------------------------------------------------

  private async cleanup(): Promise<void> {
    if (this.run.child && this.run.running) {
      logDebug('killing running Godot process');
      this.run.child.kill();
    }
    await this.server.close();
  }

  async run_(): Promise<void> {
    await this.detectGodotPath();
    if (this.godotPath) {
      console.error(`[SERVER] godot-mcp v${SERVER_VERSION} ready (godot: ${this.godotPath})`);
    } else {
      console.error('[SERVER] godot-mcp ready, but no Godot executable found.');
      console.error('[SERVER] Set GODOT_PATH, or every engine-backed tool will return an error.');
    }
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Godot MCP server running on stdio');
  }

  // -- godot discovery ------------------------------------------------------

  private async isValidGodotPath(path: string): Promise<boolean> {
    if (this.validatedPaths.has(path)) return this.validatedPaths.get(path)!;
    let valid = false;
    try {
      if (path === 'godot' || existsSync(path)) {
        const result = await runProcess(path, ['--version'], { timeoutMs: 20_000 });
        valid = result.code === 0 && result.stdout.trim().length > 0;
      }
    } catch {
      valid = false;
    }
    this.validatedPaths.set(path, valid);
    return valid;
  }

  private async detectGodotPath(): Promise<void> {
    const candidates: string[] = [];
    if (process.env.GODOT_PATH) candidates.push(normalize(process.env.GODOT_PATH));
    candidates.push('godot');
    if (process.platform === 'win32') {
      candidates.push(
        'C:\\Program Files\\Godot\\Godot.exe',
        'C:\\Program Files\\Godot\\Godot_v4.exe',
        'C:\\Program Files (x86)\\Godot\\Godot.exe'
      );
    } else if (process.platform === 'darwin') {
      candidates.push(
        '/Applications/Godot.app/Contents/MacOS/Godot',
        `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`
      );
    } else {
      candidates.push('/usr/bin/godot', '/usr/local/bin/godot', '/snap/bin/godot', `${process.env.HOME}/.local/bin/godot`);
    }
    for (const candidate of candidates) {
      if (await this.isValidGodotPath(candidate)) {
        this.godotPath = candidate;
        return;
      }
    }
  }

  private async requireGodot(): Promise<string> {
    if (!this.godotPath) {
      await this.detectGodotPath();
    }
    if (!this.godotPath) {
      throw new ToolError('No Godot executable available.', [
        'Set the GODOT_PATH environment variable to your Godot binary',
        'Verify it runs: `godot --version`',
        'Tools that only touch files (read_file, write_file, list_files) still work without Godot',
      ]);
    }
    return this.godotPath;
  }

  // -- project helpers ------------------------------------------------------

  private resolveProject(projectPath: string): string {
    if (!projectPath || !projectPath.trim()) {
      throw new ToolError('projectPath is required');
    }
    const absolute = resolve(projectPath);
    if (!existsSync(absolute)) {
      throw new ToolError(`Project directory does not exist: ${absolute}`);
    }
    if (!statSync(absolute).isDirectory()) {
      throw new ToolError(`projectPath is not a directory: ${absolute}`);
    }
    if (!existsSync(join(absolute, 'project.godot'))) {
      throw new ToolError(`Not a Godot project (no project.godot): ${absolute}`, [
        'Use list_projects to find valid projects',
      ]);
    }
    return absolute;
  }

  /** Resolve a project-relative path, refusing anything that escapes the project. */
  private resolveInsideProject(projectPath: string, relativePath: string): string {
    if (!relativePath || !relativePath.trim()) {
      throw new ToolError('A project-relative path is required');
    }
    const cleaned = relativePath.trim().replace(/^res:\/\//, '').replace(/^user:\/\//, '');
    if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
      throw new ToolError(`Path must be project-relative, got an absolute path: ${relativePath}`);
    }
    const target = resolve(projectPath, cleaned);
    const root = resolve(projectPath);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new ToolError(`Path escapes the project: ${relativePath}`);
    }
    return target;
  }

  private projectSettings(projectPath: string): Record<string, Record<string, string>> {
    const text = readTextFile(join(projectPath, 'project.godot')) ?? '';
    return parseGodotSettings(text);
  }

  private async engineVersion(): Promise<string | null> {
    try {
      const godot = await this.requireGodot();
      const result = await runProcess(godot, ['--version'], { timeoutMs: 20_000 });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  // -- operation plumbing ---------------------------------------------------

  private async callOperation(
    operation: string,
    params: Record<string, unknown>,
    projectPath: string,
    timeoutMs?: number
  ): Promise<unknown> {
    const godot = await this.requireGodot();
    const args = [
      '--headless',
      '--path',
      projectPath,
      '--script',
      this.operationsScriptPath,
      operation,
      JSON.stringify(params),
    ];
    if (GODOT_DEBUG_MODE) args.push('--debug-godot');

    logDebug(`operation ${operation} -> ${JSON.stringify(params)}`);
    const result = await runProcess(godot, args, { timeoutMs: timeoutMs ?? OPERATION_TIMEOUT_MS });
    const { result: payload } = parseOperationOutput(result.stdout);
    const errors = extractOperationErrors(result.stderr);

    if (result.timedOut) {
      throw new ToolError(`Godot operation '${operation}' timed out`, [
        'Large projects import assets on first run; retry once the editor has opened the project',
        'Raise GODOT_OP_TIMEOUT_MS if this is a slow machine',
      ]);
    }
    if (result.code !== 0 || errors.length > 0) {
      const engineErrors = extractEngineErrors(result.stderr);
      throw new ToolError(
        errors.length > 0 ? errors.join('\n') : `Godot exited with code ${result.code} (operation: ${operation})`,
        engineErrors.slice(0, 6)
      );
    }
    if (payload === undefined) {
      throw new ToolError(
        `Operation '${operation}' returned no [RESULT] payload`,
        extractEngineErrors(result.stderr)
      );
    }
    return payload;
  }

  // -- tool wiring ----------------------------------------------------------

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<any> => {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      logDebug(`tool ${name} ${JSON.stringify(args)}`);
      try {
        const handler = this.handlers()[name];
        if (!handler) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
        return await handler(args);
      } catch (error: unknown) {
        if (error instanceof McpError) throw error;
        if (error instanceof ToolError) {
          console.error(`[SERVER] ${name} failed: ${error.message}`);
          return fail(error.message, error.hints);
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[SERVER] ${name} threw: ${message}`);
        return fail(`${name} failed: ${message}`);
      }
    });
  }

  private handlers(): Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> {
    return {
      get_godot_version: () => this.handleGetGodotVersion(),
      list_projects: (a) => this.handleListProjects(a),
      get_project_info: (a) => this.handleGetProjectInfo(a),
      read_project_settings: (a) => this.handleReadProjectSettings(a),
      list_files: (a) => this.handleListFiles(a),
      read_file: (a) => this.handleReadFile(a),
      write_file: (a) => this.handleWriteFile(a),
      delete_file: (a) => this.handleDeleteFile(a),
      move_file: (a) => this.handleMoveFile(a),
      rewrite_references: (a) => this.handleRewriteReferences(a),
      find_references: (a) => this.handleFindReferences(a),
      read_scene: (a) => this.handleReadScene(a),
      scene_structure: (a) => this.handleSceneStructure(a),
      create_scene: (a) => this.handleCreateScene(a),
      add_node: (a) => this.handleAddNode(a),
      modify_node: (a) => this.handleModifyNode(a),
      remove_node: (a) => this.handleRemoveNode(a),
      attach_script: (a) => this.handleAttachScript(a),
      load_sprite: (a) => this.handleLoadSprite(a),
      save_scene: (a) => this.handleSaveScene(a),
      export_mesh_library: (a) => this.handleExportMeshLibrary(a),
      get_uid: (a) => this.handleGetUid(a),
      update_project_uids: (a) => this.handleUpdateProjectUids(a),
      validate_script: (a) => this.handleValidateScript(a),
      run_script: (a) => this.handleRunScript(a),
      launch_editor: (a) => this.handleLaunchEditor(a),
      run_project: (a) => this.handleRunProject(a),
      get_debug_output: (a) => this.handleGetDebugOutput(a),
      read_editor_log: (a) => this.handleReadEditorLog(a),
      stop_project: () => this.handleStopProject(),
    };
  }

  // -- handlers: project ----------------------------------------------------

  private async handleGetGodotVersion(): Promise<ToolResult> {
    const version = await this.engineVersion();
    if (!version) {
      throw new ToolError('Could not run the Godot binary', ['Set GODOT_PATH to a valid Godot executable']);
    }
    return ok({ version, path: this.godotPath, protocol: PROTOCOL_VERSION, server: SERVER_VERSION });
  }

  private async handleListProjects(args: Record<string, unknown>): Promise<ToolResult> {
    const directory = String(args.directory ?? '').trim();
    if (!directory) throw new ToolError('directory is required');
    const root = resolve(directory);
    if (!existsSync(root)) throw new ToolError(`Directory does not exist: ${root}`);
    const recursive = args.recursive === true;
    const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 4;
    const found: Array<{ path: string; name: string }> = [];

    const walk = (dir: string, depth: number): void => {
      if (existsSync(join(dir, 'project.godot'))) {
        found.push({ path: dir, name: basename(dir) });
      }
      if (!recursive || depth >= maxDepth) return;
      let entries: ReturnType<typeof readdirSync>;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1);
      }
    };
    walk(root, 0);
    return ok({ directory: root, count: found.length, projects: found });
  }

  private async handleGetProjectInfo(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const settings = this.projectSettings(projectPath);
    const application = settings['application'] ?? {};
    const name = unquote(application['config/name'] ?? basename(projectPath));
    const mainScene = unquote(application['run/main_scene'] ?? '');
    const engineFromProject = detectEngineVersion(settings);
    const autoloads = settingsToAutoloadNames(settings);
    const counts = countProjectFiles(projectPath);
    const engineVersion = await this.engineVersion();
    const engineMajorMinor = engineVersion ? majorMinor(engineVersion) : null;

    const warnings: string[] = [];
    if (engineFromProject && engineMajorMinor && engineFromProject !== engineMajorMinor) {
      warnings.push(
        `Project targets Godot ${engineFromProject} but the configured binary is ${engineMajorMinor}. ` +
          'Saving scenes with a different engine rewrites their format (e.g. unique_id churn).'
      );
    }
    if (!engineVersion) {
      warnings.push('No Godot executable available; engine-backed tools will fail until GODOT_PATH is set.');
    }

    return ok({
      name,
      path: projectPath,
      engine_version_target: engineFromProject,
      engine_version_binary: engineVersion,
      engine_binary: this.godotPath,
      main_scene: mainScene,
      autoloads,
      dotnet: (settings['dotnet'] ?? {})['project/assembly_name'] ?? null,
      window: {
        width: (settings['display'] ?? {})['window/size/viewport_width'] ?? null,
        height: (settings['display'] ?? {})['window/size/viewport_height'] ?? null,
      },
      file_counts: {
        scenes: counts['tscn'] ?? 0,
        scripts: (counts['gd'] ?? 0) + (counts['cs'] ?? 0),
        shaders: (counts['gdshader'] ?? 0) + (counts['shader'] ?? 0),
        resources: (counts['tres'] ?? 0) + (counts['res'] ?? 0),
        other: Object.entries(counts)
          .filter(([ext]) => !['tscn', 'gd', 'cs', 'gdshader', 'shader', 'tres', 'res'].includes(ext))
          .reduce((sum, [, n]) => sum + n, 0),
      },
      warnings,
    });
  }

  private async handleReadProjectSettings(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const settings = this.projectSettings(projectPath);
    const filter = Array.isArray(args.sections) ? args.sections.map(String) : null;
    const sections: Record<string, Record<string, string>> = {};
    for (const [section, values] of Object.entries(settings)) {
      if (filter && !filter.includes(section)) continue;
      sections[section] = values;
    }
    return ok({
      path: projectPath,
      engine_version_target: detectEngineVersion(settings),
      main_scene: unquote((settings['application'] ?? {})['run/main_scene'] ?? ''),
      autoloads: settingsToAutoloadNames(settings),
      sections,
    });
  }

  private async handleListFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const startDir = args.directory ? this.resolveInsideProject(projectPath, String(args.directory)) : projectPath;
    if (!existsSync(startDir)) throw new ToolError(`Directory does not exist in project: ${args.directory}`);
    const extensions = Array.isArray(args.extensions)
      ? args.extensions.map((ext) => String(ext).replace(/^\./, '').toLowerCase())
      : null;
    const limit = typeof args.limit === 'number' ? args.limit : 400;
    const files: Array<{ path: string; size: number }> = [];
    let truncated = false;

    const walk = (dir: string, depth: number): void => {
      if (depth > 12 || truncated) return;
      let entries: ReturnType<typeof readdirSync>;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (truncated) return;
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '';
          if (extensions && !extensions.includes(ext)) continue;
          if (files.length >= limit) {
            truncated = true;
            return;
          }
          let size = 0;
          try {
            size = statSync(full).size;
          } catch {
            size = 0;
          }
          files.push({ path: relative(projectPath, full).split(sep).join('/'), size });
        }
      }
    };
    walk(startDir, 0);

    return ok({ projectPath, count: files.length, truncated, files });
  }

  private async handleReadFile(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const filePath = this.resolveInsideProject(projectPath, String(args.filePath ?? ''));
    if (!existsSync(filePath)) throw new ToolError(`File does not exist: ${args.filePath}`);
    const stats = statSync(filePath);
    if (stats.isDirectory()) throw new ToolError(`Path is a directory, use list_files: ${args.filePath}`);
    const maxBytes = typeof args.maxBytes === 'number' ? args.maxBytes : MAX_READ_BYTES;
    const raw = readFileSync(filePath);
    const truncated = raw.length > maxBytes;
    const slice = truncated ? raw.subarray(0, maxBytes) : raw;
    if (slice.includes(0)) {
      throw new ToolError(`File looks binary: ${args.filePath}`, ['Only text files can be read']);
    }
    const content = slice.toString('utf8');
    return ok({
      filePath: String(args.filePath),
      absolutePath: filePath,
      size: stats.size,
      lines: content.split(/\r?\n/).length,
      truncated,
      content,
    });
  }

  private backupPath(projectPath: string, filePath: string): string {
    const backupDir = join(projectPath, '.godot', 'mcp_backups');
    mkdirSync(backupDir, { recursive: true });
    const rel = relative(projectPath, filePath).split(sep).join('__');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return join(backupDir, `${rel}.${stamp}.bak`);
  }

  private async handleWriteFile(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const filePath = this.resolveInsideProject(projectPath, String(args.filePath ?? ''));
    const content = args.content;
    if (typeof content !== 'string') throw new ToolError('content must be a string');
    const existed = existsSync(filePath);
    let backup: string | null = null;
    if (existed && args.backup !== false) {
      backup = this.backupPath(projectPath, filePath);
      copyFileSync(filePath, backup);
    }
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
    const after = statSync(filePath);
    return ok({
      filePath: String(args.filePath),
      absolutePath: filePath,
      created: !existed,
      bytes: after.size,
      lines: content.split(/\r?\n/).length,
      backup,
      backup_dir: join(projectPath, '.godot', 'mcp_backups'),
    });
  }

  private async handleDeleteFile(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const filePath = this.resolveInsideProject(projectPath, String(args.filePath ?? ''));
    if (!existsSync(filePath)) throw new ToolError(`File does not exist: ${args.filePath}`);
    if (statSync(filePath).isDirectory()) throw new ToolError('Refusing to delete a directory; only files');
    let backup: string | null = null;
    if (args.backup !== false) {
      backup = this.backupPath(projectPath, filePath);
      copyFileSync(filePath, backup);
    }
    unlinkSync(filePath);
    const sidecar = `${filePath}.uid`;
    let removedSidecar = false;
    if (existsSync(sidecar)) {
      unlinkSync(sidecar);
      removedSidecar = true;
    }
    return ok({ filePath: String(args.filePath), deleted: true, removed_uid_sidecar: removedSidecar, backup });
  }

  // -- reference scanning / moving -----------------------------------------

  /** Text files that can hold res:// references (excludes build output and archives). */
  private referenceFiles(projectPath: string): string[] {
    const skip = new Set([...SKIP_DIRS, 'android', 'apk', '_attic', '_sources']);
    const found: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 12) return;
      let entries: ReturnType<typeof readdirSync>;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.import') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue;
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '';
          if (['tscn', 'tres', 'scn', 'res', 'gd', 'cs', 'gdshader', 'shader', 'cfg', 'import', 'godot'].includes(ext)) {
            found.push(full);
          }
        }
      }
    };
    walk(projectPath, 0);
    return found;
  }

  private fileUid(absolutePath: string): string | null {
    for (const candidate of [`${absolutePath}.uid`, absolutePath]) {
      const text = readTextFile(candidate);
      if (!text) continue;
      const header = text.match(/uid="(uid:\/\/[^"]+)"/);
      if (header) return header[1];
      const sidecar = text.trim();
      if (/^uid:\/\/\w+$/.test(sidecar)) return sidecar;
    }
    return null;
  }

  private async handleRewriteReferences(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const normalise = (value: string): string => value.trim().replace(/^res:\/\//, '').replace(/\\/g, '/');
    const fromRel = normalise(String(args.fromPath ?? ''));
    const toRel = normalise(String(args.toPath ?? ''));
    if (!fromRel || !toRel) throw new ToolError('fromPath and toPath are required');
    if (fromRel === toRel) throw new ToolError('fromPath and toPath are the same');
    const dryRun = args.dryRun === true;

    const changed: Array<{ file: string; replacements: number }> = [];
    for (const file of this.referenceFiles(projectPath)) {
      const text = readTextFile(file);
      if (!text) continue;
      const count = text.split(`res://${fromRel}`).length - 1
        + text.split(`"${fromRel}"`).length - 1
        + text.split(`'${fromRel}'`).length - 1;
      if (count === 0) continue;
      const next = text
        .replaceAll(`res://${fromRel}`, `res://${toRel}`)
        .replaceAll(`"${fromRel}"`, `"${toRel}"`)
        .replaceAll(`'${fromRel}'`, `'${toRel}'`);
      if (!dryRun) writeFileSync(file, next, 'utf8');
      changed.push({ file: relative(projectPath, file).split(sep).join('/'), replacements: count });
    }

    return ok({
      from: fromRel,
      to: toRel,
      dryRun,
      files_changed: changed.length,
      total_replacements: changed.reduce((sum, entry) => sum + entry.replacements, 0),
      changes: changed.slice(0, 100),
    });
  }

  private async handleFindReferences(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const target = this.resolveInsideProject(projectPath, String(args.filePath ?? ''));
    if (!existsSync(target)) throw new ToolError(`File does not exist: ${args.filePath}`);
    const rel = relative(projectPath, target).split(sep).join('/');
    const uid = this.fileUid(target);
    const needles = [`res://${rel}`, `"${rel}"`, `'${rel}'`];
    if (uid) needles.push(uid);

    const hits: Array<{ file: string; line: number; text: string }> = [];
    for (const file of this.referenceFiles(projectPath)) {
      // skip the file itself and its own sidecars (they always reference it)
      if (file === target || file === `${target}.import` || file === `${target}.uid`) continue;
      const text = readTextFile(file);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (needles.some((needle) => line.includes(needle))) {
          hits.push({
            file: relative(projectPath, file).split(sep).join('/'),
            line: index + 1,
            text: line.trim().slice(0, 240),
          });
        }
      }
    }
    return ok({
      filePath: rel,
      uid,
      reference_count: hits.length,
      referenced: hits.length > 0,
      references: hits.slice(0, 200),
      truncated: hits.length > 200,
    });
  }

  private async handleMoveFile(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const from = this.resolveInsideProject(projectPath, String(args.from ?? ''));
    const to = this.resolveInsideProject(projectPath, String(args.to ?? ''));
    if (!existsSync(from)) throw new ToolError(`Source does not exist: ${args.from}`);
    if (statSync(from).isDirectory()) throw new ToolError('move_file only handles files; move directories with the shell');
    if (from === to) throw new ToolError('from and to are the same path');
    if (existsSync(to) && args.overwrite !== true) {
      throw new ToolError(`Destination already exists: ${args.to}`, ['Pass overwrite=true to replace it']);
    }

    const fromRel = relative(projectPath, from).split(sep).join('/');
    const toRel = relative(projectPath, to).split(sep).join('/');
    if (args.updateReferences !== false) {
      const users = this.referenceFiles(projectPath).filter((file) => file !== from);
      let blocking = 0;
      for (const file of users) {
        const text = readTextFile(file) ?? '';
        if (text.includes(`res://${fromRel}`)) blocking += 1;
      }
      logDebug(`move_file: ${blocking} files reference ${fromRel}`);
    }

    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
    } catch {
      copyFileSync(from, to);
      unlinkSync(from);
    }

    // Carry the .import sidecar (texture/audio/resources) so the UID survives.
    const sidecarsMoved: string[] = [];
    for (const suffix of ['.import', '.uid']) {
      const sidecar = `${from}${suffix}`;
      if (!existsSync(sidecar)) continue;
      const targetSidecar = `${to}${suffix}`;
      if (existsSync(targetSidecar)) unlinkSync(targetSidecar);
      try {
        renameSync(sidecar, targetSidecar);
      } catch {
        copyFileSync(sidecar, targetSidecar);
        unlinkSync(sidecar);
      }
      sidecarsMoved.push(suffix);
      if (suffix === '.import') {
        const text = readTextFile(targetSidecar);
        if (text) {
          const rewritten = text
            .replaceAll(`source_file="res://${fromRel}"`, `source_file="res://${toRel}"`)
            .replaceAll(`res://${fromRel}`, `res://${toRel}`);
          if (rewritten !== text) writeFileSync(targetSidecar, rewritten, 'utf8');
        }
      }
    }

    const updated: Array<{ file: string; replacements: number }> = [];
    if (args.updateReferences !== false) {
      for (const file of this.referenceFiles(projectPath)) {
        const text = readTextFile(file);
        if (!text) continue;
        const next = text
          .replaceAll(`res://${fromRel}`, `res://${toRel}`)
          .replaceAll(`"${fromRel}"`, `"${toRel}"`)
          .replaceAll(`'${fromRel}'`, `'${toRel}'`);
        if (next !== text) {
          const replacements = text.split(`res://${fromRel}`).length - 1
            + text.split(`"${fromRel}"`).length - 1;
          writeFileSync(file, next, 'utf8');
          updated.push({ file: relative(projectPath, file).split(sep).join('/'), replacements });
        }
      }
    }

    return ok({
      from: fromRel,
      to: toRel,
      sidecars_moved: sidecarsMoved,
      references_updated: updated,
      note: 'Godot re-imports the asset on next editor/headless start; UIDs are preserved through the .import sidecar.',
    });
  }

  // -- handlers: scenes -----------------------------------------------------
  private sceneParams(args: Record<string, unknown>): { projectPath: string; scenePath: string } {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const scenePath = String(args.scenePath ?? '').trim();
    if (!scenePath) throw new ToolError('scenePath is required');
    return { projectPath, scenePath };
  }

  private async handleReadScene(args: Record<string, unknown>): Promise<ToolResult> {
    const { projectPath, scenePath } = this.sceneParams(args);
    const params: Record<string, unknown> = {
      scene_path: scenePath,
      include_properties: args.includeProperties !== false,
    };
    if (args.nodePath) params.node_path = String(args.nodePath);
    if (typeof args.maxNodes === 'number') params.max_nodes = args.maxNodes;
    const result = await this.callOperation('read_scene', params, projectPath, 60_000);
    return ok(result);
  }

  private async handleSceneStructure(args: Record<string, unknown>): Promise<ToolResult> {
    const { projectPath, scenePath } = this.sceneParams(args);
    const result = await this.callOperation('scene_structure', { scene_path: scenePath }, projectPath, 60_000);
    return ok(result);
  }

  private async handleCreateScene(args: Record<string, unknown>): Promise<ToolResult> {
    const { projectPath, scenePath } = this.sceneParams(args);
    const params: Record<string, unknown> = {
      scene_path: scenePath,
      root_node_type: args.rootNodeType ?? 'Node2D',
      overwrite: args.overwrite === true,
    };
    if (args.rootNodeName) params.root_node_name = String(args.rootNodeName);
    if (args.properties) params.properties = args.properties;
    return ok(await this.callOperation('create_scene', params, projectPath));
  }

  private async handleAddNode(args: Record<string, unknown>): Promise<ToolResult> {
    const { projectPath, scenePath } = this.sceneParams(args);
    const nodeType = String(args.nodeType ?? '').trim();
    const nodeName = String(args.nodeName ?? '').trim();
    if (!nodeType) throw new ToolError('nodeType is required');
    if (!nodeName) throw new ToolError('nodeName is required');
    const params: Record<string, unknown> = {
      scene_path: scenePath,
      node_type: nodeType,
      node_name: nodeName,
      parent_node_path: args.parentNodePath ?? 'root',
      force: args.force === true,
    };
    if (args.properties) params.properties = args.properties;
    return ok(await this.callOperation('add_node', params, projectPath));
  }

  private async handleModifyNode(args: Record<string, unknown>): Promise<ToolResult> {
    const { projectPath, scenePath } = this.sceneParams(args);
    const nodePath = String(args.nodePath ?? '').trim();
    if (!nodePath) throw new ToolError('nodePath is required');
    const params: Record<string, unknown> = {
      scene_path: scenePath,
      node_path: nodePath,
      force: args.force === true,
    };
    if (args.properties) params.properties = args.properties;
    if (args.newName) params.new_name = String(args.newName);
    return ok(await this.callOperation('modify_node', params, projectPath));
  }

  private async handleRemoveNode(args: Record<string, unknown>): Promise<ToolResult> {
    const { projectPath, scenePath } = this.sceneParams(args);
    const nodePath = String(args.nodePath ?? '').trim();
    if (!nodePath) throw new ToolError('nodePath is required');
    return ok(
      await this.callOperation(
        'remove_node',
        {
          scene_path: scenePath,
          node_path: nodePath,
          recursive: args.recursive === true,
          force: args.force === true,
        },
        projectPath
      )
    );
  }

  private async handleAttachScript(args: Record<string, unknown>): Promise<ToolResult> {
    const { projectPath, scenePath } = this.sceneParams(args);
    const scriptPath = String(args.scriptPath ?? '').trim();
    if (!scriptPath) throw new ToolError('scriptPath is required');
    return ok(
      await this.callOperation(
        'attach_script',
        {
          scene_path: scenePath,
          node_path: args.nodePath ?? 'root',
          script_path: scriptPath,
          force: args.force === true,
        },
        projectPath
      )
    );
  }

  private async handleLoadSprite(args: Record<string, unknown>): Promise<ToolResult> {
    const { projectPath, scenePath } = this.sceneParams(args);
    const nodePath = String(args.nodePath ?? '').trim();
    const texturePath = String(args.texturePath ?? '').trim();
    if (!nodePath) throw new ToolError('nodePath is required');
    if (!texturePath) throw new ToolError('texturePath is required');
    return ok(
      await this.callOperation(
        'load_sprite',
        {
          scene_path: scenePath,
          node_path: nodePath,
          texture_path: texturePath,
          force: args.force === true,
        },
        projectPath
      )
    );
  }

  private async handleSaveScene(args: Record<string, unknown>): Promise<ToolResult> {
    const { projectPath, scenePath } = this.sceneParams(args);
    const params: Record<string, unknown> = {
      scene_path: scenePath,
      overwrite: args.overwrite === true,
    };
    if (args.newPath) params.new_path = String(args.newPath);
    return ok(await this.callOperation('save_scene', params, projectPath));
  }

  private async handleExportMeshLibrary(args: Record<string, unknown>): Promise<ToolResult> {
    const { projectPath, scenePath } = this.sceneParams(args);
    const outputPath = String(args.outputPath ?? '').trim();
    if (!outputPath) throw new ToolError('outputPath is required');
    const params: Record<string, unknown> = { scene_path: scenePath, output_path: outputPath };
    if (Array.isArray(args.meshItemNames)) params.mesh_item_names = args.meshItemNames;
    return ok(await this.callOperation('export_mesh_library', params, projectPath));
  }

  private async handleGetUid(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const filePath = String(args.filePath ?? '').trim();
    if (!filePath) throw new ToolError('filePath is required');
    return ok(await this.callOperation('get_uid', { file_path: filePath }, projectPath, 60_000));
  }

  private async handleUpdateProjectUids(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    return ok(
      await this.callOperation(
        'resave_resources',
        { project_path: 'res://', dry_run: args.dryRun === true },
        projectPath,
        300_000
      )
    );
  }

  // -- handlers: verification ----------------------------------------------

  private async handleValidateScript(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const targets: string[] = [];
    if (args.filePath) targets.push(String(args.filePath));
    if (Array.isArray(args.files)) targets.push(...args.files.map(String));
    if (targets.length === 0) {
      throw new ToolError('Provide filePath or files', ["Example: { filePath: 'Scripts/player.gd' }"]);
    }

    const godot = await this.requireGodot();
    const autoloads = new Set(settingsToAutoloadNames(this.projectSettings(projectPath)));
    const results: Array<Record<string, unknown>> = [];

    for (const target of targets) {
      const relativeTarget = target.replace(/^res:\/\//, '');
      const absolute = this.resolveInsideProject(projectPath, relativeTarget);
      if (!existsSync(absolute)) {
        results.push({ file: relativeTarget, valid: false, errors: [{ message: 'File does not exist' }] });
        continue;
      }
      if (!relativeTarget.endsWith('.gd')) {
        results.push({
          file: relativeTarget,
          valid: null,
          skipped: true,
          errors: [],
          note: 'Only .gd files can be parse-checked by this server',
        });
        continue;
      }

      const run = await runProcess(
        godot,
        ['--headless', '--path', projectPath, '--check-only', '--script', `res://${relativeTarget}`],
        { timeoutMs: 90_000 }
      );

      const allErrors: Array<{ message: string; file?: string; line?: number }> = [];
      const lines = run.stderr.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line.startsWith('SCRIPT ERROR:')) continue;
        let message = line.replace(/^SCRIPT ERROR:\s*/, '');
        message = message.replace(/^(Parse|Compile) Error:\s*/, '');
        const locationLine = (lines[index + 1] ?? '').trim();
        const location = locationLine.match(/at: .*\((res:\/\/[^:)]+):(\d+)\)/);
        allErrors.push({
          message,
          file: location ? location[1] : relativeTarget,
          line: location ? Number(location[2]) : undefined,
        });
      }

      const autoloadNoise = /^Identifier not found:\s*([A-Za-z_][A-Za-z0-9_]*)$/;
      const realErrors = allErrors.filter((entry) => {
        const match = entry.message.match(autoloadNoise);
        if (match && autoloads.has(match[1])) return false;
        return true;
      });
      results.push({
        file: relativeTarget,
        valid: realErrors.length === 0,
        exit_code: run.code,
        errors: realErrors,
        filtered_autoload_false_positives: allErrors.length - realErrors.length,
      });
    }

    return ok({
      all_valid: results.every((entry) => entry.valid !== false),
      checked: results.length,
      results,
    });
  }

  private async handleRunScript(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const scriptPath = String(args.scriptPath ?? '').trim();
    if (!scriptPath) throw new ToolError('scriptPath is required');
    const absolute = this.resolveInsideProject(projectPath, scriptPath);
    if (!existsSync(absolute)) throw new ToolError(`Script does not exist: ${scriptPath}`);
    const godot = await this.requireGodot();
    const extra = Array.isArray(args.args) ? args.args.map(String) : [];
    const cmdArgs = ['--headless', '--path', projectPath, '--script', `res://${scriptPath.replace(/^res:\/\//, '')}`];
    if (extra.length > 0) cmdArgs.push('--', ...extra);
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 120_000;
    const run = await runProcess(godot, cmdArgs, { timeoutMs, cwd: projectPath });
    return ok({
      script: scriptPath,
      exit_code: run.code,
      timed_out: run.timedOut,
      success: run.code === 0,
      stdout: run.stdout.trim(),
      stderr: run.stderr.trim(),
    });
  }

  // -- handlers: run / debug -----------------------------------------------

  private async handleLaunchEditor(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const godot = await this.requireGodot();
    const child = spawn(godot, ['--editor', '--path', projectPath], { stdio: 'ignore', windowsHide: false });
    child.on('error', (error) => console.error('[SERVER] failed to launch editor:', error.message));
    return ok({
      launched: true,
      projectPath,
      pid: child.pid ?? null,
      note: 'The editor keeps running in the background; this server does not manage its lifetime.',
    });
  }

  private appendLog(state: RunState, stream: 'out' | 'err', chunk: Buffer): void {
    const target = stream === 'out' ? state.output : state.errors;
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      target.push(line);
    }
    if (target.length > MAX_LOG_LINES) {
      const excess = target.length - MAX_LOG_LINES;
      target.splice(0, excess);
      if (stream === 'out') state.droppedOutput += excess;
      else state.droppedErrors += excess;
    }
  }

  private async handleRunProject(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const godot = await this.requireGodot();

    if (this.run.child && this.run.running) {
      logDebug('stopping previous run');
      this.run.child.kill();
    }

    const cmdArgs: string[] = ['--path', projectPath];
    if (args.headless === true) cmdArgs.push('--headless');
    if (args.debugBuild === true) cmdArgs.push('-d');
    if (typeof args.quitAfter === 'number') cmdArgs.push('--quit-after', String(Math.trunc(args.quitAfter)));
    if (args.scene) cmdArgs.push(`res://${String(args.scene).replace(/^res:\/\//, '')}`);
    if (Array.isArray(args.args) && args.args.length > 0) cmdArgs.push('--', ...args.args.map(String));

    const state: RunState = {
      child: null,
      running: true,
      exitCode: null,
      output: [],
      errors: [],
      droppedOutput: 0,
      droppedErrors: 0,
      projectPath,
      startedAt: Date.now(),
      endedAt: null,
    };

    logDebug(`run_project: ${godot} ${cmdArgs.join(' ')}`);
    const child = spawn(godot, cmdArgs, { cwd: projectPath, windowsHide: args.headless === true });
    state.child = child;
    this.run = state;

    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(state, 'out', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(state, 'err', chunk));
    child.on('error', (error: Error) => {
      state.errors.push(`[spawn error] ${error.message}`);
      state.running = false;
      state.exitCode = -1;
      state.endedAt = Date.now();
    });
    child.on('exit', (code: number | null) => {
      state.running = false;
      state.exitCode = code === null ? -1 : code;
      state.endedAt = Date.now();
      logDebug(`project exited with code ${state.exitCode}`);
    });

    const waitMs = typeof args.waitMs === 'number' ? args.waitMs : 250;
    if (waitMs > 0) {
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, Math.min(waitMs, 5_000));
        child.once('exit', () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    }

    return ok({
      started: true,
      pid: child.pid ?? null,
      projectPath,
      command: [godot, ...cmdArgs].join(' '),
      running: state.running,
      exitCode: state.exitCode,
      output: state.output.slice(-40),
      errors: state.errors.slice(-40),
      note: 'Output is retained after exit; call get_debug_output for the full log.',
    });
  }

  private async handleGetDebugOutput(args: Record<string, unknown>): Promise<ToolResult> {
    const state = this.run;
    if (!state.startedAt) {
      throw new ToolError('No run has been started yet.', ['Call run_project first']);
    }
    const since = typeof args.since === 'number' ? Math.max(0, Math.trunc(args.since)) : 0;
    const tail = typeof args.tail === 'number' ? Math.max(1, Math.trunc(args.tail)) : 200;
    const includeErrors = args.includeErrors !== false;
    const severity = typeof args.severity === 'string' ? args.severity : 'all';

    const outputFromSince = state.output.slice(since);
    const outputTruncatedToTail = outputFromSince.slice(-tail);
    const split = classifyStderr(state.errors);

    const errors = split.errors.slice(-tail);
    const warnings = split.warnings.slice(-tail);
    const other = split.other.slice(-tail);

    let stderrLines: string[] = [];
    if (includeErrors) {
      if (severity === 'errors') stderrLines = errors;
      else if (severity === 'warnings') stderrLines = warnings;
      else stderrLines = [...other, ...warnings, ...errors];
    }

    const result = {
      running: state.running,
      exitCode: state.exitCode,
      startedAt: new Date(state.startedAt).toISOString(),
      endedAt: state.endedAt ? new Date(state.endedAt).toISOString() : null,
      output_lines_total: state.output.length,
      stderr_lines_total: state.errors.length,
      counts: {
        errors: split.errors.length,
        warnings: split.warnings.length,
        other: split.other.length,
      },
      dropped_lines: state.droppedOutput + state.droppedErrors,
      nextIndex: state.output.length,
      truncated_to_tail: outputFromSince.length > outputTruncatedToTail.length,
      output: outputTruncatedToTail,
      stderr: stderrLines,
    };

    if (args.clear === true) {
      state.output = [];
      state.errors = [];
      state.droppedOutput = 0;
      state.droppedErrors = 0;
    }

    return ok(result);
  }

  /**
   * The Godot editor keeps its own log under the OS user-data directory. A run
   * started with F5 inside the editor never reaches this server's pipes, so this
   * file is the only way to see those errors.
   */
  private async handleReadEditorLog(args: Record<string, unknown>): Promise<ToolResult> {
    const projectPath = this.resolveProject(String(args.projectPath ?? ''));
    const explicit = typeof args.logPath === 'string' ? args.logPath.trim() : '';
    const logPath = explicit || this.editorLogPath(projectPath);

    if (!existsSync(logPath)) {
      throw new ToolError(`Editor log not found: ${logPath}`, [
        'Open the project in the Godot editor once so it creates user://logs/godot.log',
        'Or pass logPath explicitly',
      ]);
    }

    const raw = readFileSync(logPath, 'utf8');
    const stats = statSync(logPath);
    const split = classifyStderr(raw.split(/\r?\n/));
    const tail = typeof args.tail === 'number' ? Math.max(1, Math.trunc(args.tail)) : 200;
    const severity = typeof args.severity === 'string' ? args.severity : 'all';

    const response: Record<string, unknown> = {
      logPath,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      counts: {
        errors: split.errors.length,
        warnings: split.warnings.length,
        prints: split.other.length,
      },
    };
    if (severity !== 'warnings') response.errors = split.errors.slice(-tail);
    if (severity !== 'errors') response.warnings = split.warnings.slice(-tail);
    if (severity === 'all') response.prints = split.other.slice(-tail);

    return ok(response);
  }

  /** `%APPDATA%/Godot/app_userdata/<config/name>/logs/godot.log` (per platform). */
  private editorLogPath(projectPath: string): string {
    const settings = this.projectSettings(projectPath);
    const name = unquote((settings['application'] ?? {})['config/name'] ?? basename(projectPath));
    let base: string;
    if (process.platform === 'win32') {
      base = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Godot', 'app_userdata');
    } else if (process.platform === 'darwin') {
      base = join(homedir(), 'Library', 'Application Support', 'Godot', 'app_userdata');
    } else {
      base = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'godot', 'app_userdata');
    }
    return join(base, name, 'logs', 'godot.log');
  }

  private async handleStopProject(): Promise<ToolResult> {
    const state = this.run;
    if (!state.child || !state.running) {
      return ok({
        stopped: false,
        exitCode: state.exitCode,
        note: state.startedAt
          ? 'Nothing was running; the last run already exited. Its output is still available via get_debug_output.'
          : 'No run has been started yet.',
        output: state.output.slice(-60),
        errors: state.errors.slice(-40),
      });
    }
    state.child.kill();
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 3_000);
      state.child?.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    return ok({
      stopped: true,
      exitCode: state.exitCode,
      output: state.output.slice(-60),
      errors: state.errors.slice(-40),
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const server = new GodotServer();
server.run_().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Failed to start godot-mcp:', message);
  process.exit(1);
});
