export { diffSnapshots, highestSeverity } from './diff.js';
export { resolveRange } from './git.js';
export { renderText, renderMarkdown, renderJson, renderGithub, meetsThreshold } from './report.js';
export { diffInstructionFile } from './instructions.js';
export { diffServers, extractServers } from './mcp.js';
export { diffClaudeSettings } from './claude.js';
export { classify } from './discover.js';
export { RULES } from './rules.js';
export type { DiffResult, Finding, FileChange, Severity, Snapshot } from './types.js';
