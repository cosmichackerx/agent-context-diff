import type { FileKind } from './types.js';

const INSTRUCTION_BASENAMES = new Set([
  'AGENTS.md',
  'AGENT.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'GEMINI.md',
  'AGENTS.override.md',
  'SKILL.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
]);

const INSTRUCTION_PATHS: RegExp[] = [
  /^\.github\/copilot-instructions\.md$/,
  /^\.github\/instructions\/.+\.md$/,
  /^\.cursor\/rules\/.+\.(md|mdc)$/,
  /^\.clinerules\/.+\.md$/,
  /^\.windsurf\/rules\/.+\.md$/,
  /^\.roo\/rules[^/]*\/.+\.md$/,
  /^\.junie\/guidelines\.md$/,
  /^\.claude\/(commands|agents|skills)\/.+\.md$/,
  /^\.agents\/.+\.md$/,
];

const MCP_CONFIG_PATHS: RegExp[] = [
  /(^|\/)\.mcp\.json$/,
  /^\.cursor\/mcp\.json$/,
  /^\.vscode\/mcp\.json$/,
  /^\.gemini\/settings\.json$/,
  /^\.roo\/mcp\.json$/,
  /^\.kiro\/settings\/mcp\.json$/,
  /^\.windsurf\/mcp\.json$/,
  /^\.zed\/settings\.json$/,
  /^opencode\.jsonc?$/,
  /^\.opencode\/opencode\.jsonc?$/,
  /^\.agents\/agents\.json$/,
];

const CLAUDE_SETTINGS = /^\.claude\/settings(\.local)?\.json$/;

/** Return what kind of agent file `path` is, or `null` if it is not one we track. */
export function classify(path: string): FileKind | null {
  const parts = path.split('/');
  if (parts.includes('node_modules') || parts.includes('.git')) return null;
  const base = parts[parts.length - 1] as string;
  if (CLAUDE_SETTINGS.test(path)) return 'claude-settings';
  if (MCP_CONFIG_PATHS.some((re) => re.test(path))) return 'mcp-config';
  if (INSTRUCTION_BASENAMES.has(base)) return 'instructions';
  if (INSTRUCTION_PATHS.some((re) => re.test(path))) return 'instructions';
  return null;
}
