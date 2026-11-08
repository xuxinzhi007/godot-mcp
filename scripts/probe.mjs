#!/usr/bin/env node
/**
 * Manual smoke-test probe for the Godot MCP server.
 *
 * Spawns `build/index.js` over stdio and replays a JSON plan of tool calls, so
 * you can verify real behaviour against a real project without a client:
 *
 *   GODOT_PATH=/path/to/godot node scripts/probe.mjs plan.json
 *
 * Plan format:
 *   {
 *     "listTools": true,
 *     "steps": [
 *       { "label": "read a scene", "tool": "read_scene", "args": { ... } },
 *       { "tool": "add_node", "args": { ... }, "expect": "error" },
 *       { "sleep": 2000 }
 *     ]
 *   }
 *
 * By default it drives the `godot` server from build/index.js. Set
 * PROBE_MCP=<name> to drive any stdio server configured in ~/.pi/agent/mcp.json
 * (for example PROBE_MCP=comfyui).
 *
 * Exit code is 1 when any step does not match its expectation.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const planPath = process.argv[2];
if (!planPath) {
  console.error('usage: node scripts/probe.mjs <plan.json>');
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const showDebug = process.env.SHOW_DEBUG === 'true';

function resolveServer() {
  const name = process.env.PROBE_MCP;
  if (!name || name === 'godot') {
    return { command: process.execPath, args: ['build/index.js'], env: {} };
  }
  const configPath = join(homedir(), '.pi', 'agent', 'mcp.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const entry = config.mcpServers?.[name];
  if (!entry?.command) {
    throw new Error(`MCP server "${name}" not found in ${configPath}`);
  }
  return { command: entry.command, args: entry.args ?? [], env: entry.env ?? {} };
}

const target = resolveServer();
const transport = new StdioClientTransport({
  command: target.command,
  args: target.args,
  env: { ...process.env, ...target.env, DEBUG: showDebug ? 'true' : 'false' },
  stderr: 'pipe',
});

const client = new Client({ name: 'godot-mcp-probe', version: '1.0.0' }, { capabilities: {} });
let serverStderr = '';
transport.stderr?.on('data', (chunk) => {
  serverStderr += chunk.toString();
  if (showDebug) process.stderr.write('[server] ' + chunk.toString());
});

await client.connect(transport);

if (plan.listTools) {
  const { tools } = await client.listTools();
  console.log(`\n### tools (${tools.length}): ${tools.map((tool) => tool.name).join(', ')}`);
}

let pass = 0;
let fail = 0;

for (const step of plan.steps) {
  if (step.sleep) {
    await new Promise((r) => setTimeout(r, step.sleep));
    console.log(`\n===== (sleep ${step.sleep}ms)`);
    continue;
  }
  const label = step.label || step.tool;
  console.log(`\n===== ${label} :: ${step.tool}`);
  const started = Date.now();
  try {
    const res = await client.callTool({ name: step.tool, arguments: step.args || {} });
    const ms = Date.now() - started;
    const text = (res.content || []).map((c) => c.text ?? `<${c.type}>`).join('\n');
    const isError = res.isError === true;
    const expectError = step.expect === 'error';
    const matched = expectError ? isError : !isError;
    if (matched) pass += 1;
    else fail += 1;
    console.log(`--- isError=${isError} expected=${step.expect || 'ok'} => ${matched ? 'PASS' : 'FAIL'} (${ms}ms)`);
    const limit = step.show === 'all' ? 200_000 : 1200;
    console.log(text.length > limit ? `${text.slice(0, limit)}\n...[truncated]` : text);
  } catch (error) {
    fail += 1;
    console.log(`--- THREW: ${error.message}`);
  }
}

console.log(`\n### PASS=${pass} FAIL=${fail}`);
await client.close();
if (serverStderr.trim()) {
  console.log('\n### server stderr (tail):\n' + serverStderr.trim().split('\n').slice(-10).join('\n'));
}
process.exit(fail > 0 ? 1 : 0);
