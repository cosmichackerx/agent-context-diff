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

// Documentation for the file locations:
//   Aider            https://aider.chat/docs/usage/conventions.html
//   Amazon Q         https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/context-project-rules.html
//   Kiro steering    https://kiro.dev/docs/steering/
//   Continue rules   https://docs.continue.dev/customize/deep-dives/rules
//   Claude rules     https://code.claude.com/docs/en/memory
//   Augment rules    https://docs.augmentcode.com/setup-augment/guidelines
//   Amazon Q MCP     https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/mcp-ide.html
//   Copilot files    https://code.visualstudio.com/docs/agent-customization/prompt-files
const INSTRUCTION_PATHS: RegExp[] = [
  /^CONVENTIONS\.md$/, // Aider, loaded with `--read CONVENTIONS.md`
  /^\.amazonq\/rules\/.+\.md$/,
  /^\.kiro\/steering\/.+\.md$/,
  /^\.continue\/rules\/.+\.md$/,
  /^\.augment\/rules\/.+\.(md|mdc)$/,
  /^\.augment\/guidelines\.md$/,
  /^\.trae\/rules\/.+\.md$/,
  /^\.github\/prompts\/.+\.prompt\.md$/, // Copilot prompt files
  /^\.github\/chatmodes\/.+\.chatmode\.md$/, // Copilot chat modes (legacy)
  /^\.github\/agents\/.+\.md$/, // Copilot custom agents (*.agent.md)
  /^\.cursor\/commands\/.+\.md$/,
  /^\.clinerules\/.+\.txt$/,
  /^\.github\/copilot-instructions\.md$/,
  /^\.github\/instructions\/.+\.md$/,
  /^\.cursor\/rules\/.+\.(md|mdc)$/,
  /^\.clinerules\/.+\.md$/,
  /^\.windsurf\/rules\/.+\.md$/,
  /^\.roo\/rules[^/]*\/.+\.md$/,
  /^\.junie\/guidelines\.md$/,
  /^\.claude\/(commands|agents|skills|rules)\/.+\.md$/,
  /^\.agents\/.+\.md$/,
];

const MCP_CONFIG_PATHS: RegExp[] = [
  /^\.continue\/mcpServers\/.+\.json$/, // Continue: Claude-Desktop style JSON blocks
  /^\.amazonq\/(default|mcp)\.json$/, // Amazon Q IDE + CLI workspace config
  /^\.amazonq\/cli-agents\/.+\.json$/, // Amazon Q CLI custom agents (mcpServers inside)
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
