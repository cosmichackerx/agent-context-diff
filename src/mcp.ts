import { isRecord } from './jsonc.js';
import type { Finding, Severity } from './types.js';
import { argHasSecret, isLiteralSecret, redact, redactArg, redactUrl } from './secrets.js';

export interface McpServer {
  name: string;
  transport: string;
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  approvals: string[]; // e.g. "autoApprove: *", "trust: true"
  disabled: boolean;
}

const SERVER_KEYS = ['mcpServers', 'servers', 'context_servers', 'mcp'] as const;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(v)) for (const [k, val] of Object.entries(v)) out[k] = typeof val === 'string' ? val : JSON.stringify(val);
  return out;
}

function approvals(cfg: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['autoApprove', 'alwaysAllow', 'auto_approve', 'always_allow']) {
    const v = cfg[key];
    if (Array.isArray(v) && v.length > 0) out.push(`${key}: ${v.map(String).sort().join(', ')}`);
    else if (v === true) out.push(`${key}: true`);
  }
  if (cfg.trust === true) out.push('trust: true');
  return out;
}

export function normalizeServer(name: string, cfg: Record<string, unknown>): McpServer {
  let command = str(cfg.command);
  let args: string[] = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
  let env = strMap(cfg.env);
  if (Array.isArray(cfg.command)) {
    // opencode style: command is the whole argv
    const argv = cfg.command.map(String);
    command = argv[0];
    args = argv.slice(1);
  } else if (isRecord(cfg.command)) {
    // zed style: command: { path, args, env }
    command = str(cfg.command.path);
    if (Array.isArray(cfg.command.args)) args = cfg.command.args.map(String);
    env = { ...env, ...strMap(cfg.command.env) };
  }
  env = { ...env, ...strMap(cfg.environment) };
  const url = str(cfg.url) ?? str(cfg.serverUrl) ?? str(cfg.httpUrl) ?? str(cfg.endpoint);
  let transport = str(cfg.type) ?? str(cfg.transport) ?? (url ? 'http' : command ? 'stdio' : 'unknown');
  if (transport === 'local') transport = 'stdio';
  if (transport === 'remote') transport = 'http';
  return {
    name,
    transport,
    command,
    args,
    url,
    env,
    headers: { ...strMap(cfg.headers), ...strMap(cfg.http_headers) },
    approvals: approvals(cfg),
    disabled: cfg.disabled === true || cfg.enabled === false,
  };
}

/** Extract MCP servers from a parsed config document (`mcpServers`, `servers`, `context_servers`, `mcp`). */
export function extractServers(doc: unknown): Map<string, McpServer> {
  const out = new Map<string, McpServer>();
  if (!isRecord(doc)) return out;
  for (const key of SERVER_KEYS) {
    const block = doc[key];
    if (!isRecord(block)) continue;
    for (const [name, cfg] of Object.entries(block)) {
      if (isRecord(cfg) && (cfg.command !== undefined || cfg.url !== undefined || cfg.serverUrl !== undefined || cfg.httpUrl !== undefined || cfg.type !== undefined || cfg.args !== undefined || cfg.endpoint !== undefined)) {
        out.set(name, normalizeServer(name, cfg));
      }
    }
  }
  return out;
}

export function describeServer(s: McpServer): string {
  if (s.url) return `${s.transport} ${redactUrl(s.url)}`;
  const cmd = [s.command ?? '?', ...s.args.map(redactArg)].join(' ');
  return `${s.transport} \`${cmd.length > 120 ? `${cmd.slice(0, 119)}…` : cmd}\``;
}

// ---------------------------------------------------------------------------------------------
// package pinning
// ---------------------------------------------------------------------------------------------

function firstPositional(args: string[], optionsWithValue: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (optionsWithValue.includes(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}

const DOCKER_OPTIONS_WITH_VALUE = ['-e', '--env', '-v', '--volume', '--name', '-p', '--publish', '--network', '--mount', '-w', '--workdir', '--entrypoint', '--env-file', '-u', '--user', '--platform'];

function baseCommand(command: string | undefined): string {
  return (command ?? '').replace(/\\/g, '/').split('/').pop()?.replace(/\.(cmd|exe|bat)$/i, '') ?? '';
}

/** For package runners (npx, uvx, docker ...) return `{ spec, pinned }` or `null` if not a runner. */
export function packageSpec(s: McpServer): { spec: string; pinned: boolean } | null {
  const cmd = baseCommand(s.command);
  const args = s.args;
  if (cmd === 'npx' || cmd === 'bunx' || ((cmd === 'pnpm' || cmd === 'yarn') && args[0] === 'dlx') || (cmd === 'npm' && args[0] === 'exec')) {
    const rest = cmd === 'npx' || cmd === 'bunx' ? args : args.slice(1);
    const spec = firstPositional(rest, ['-p', '--package', '-c', '--call', '--registry']);
    if (!spec) return null;
    const at = spec.lastIndexOf('@');
    const version = at > 0 ? spec.slice(at + 1) : '';
    return { spec, pinned: version !== '' && !/^(latest|next|beta|canary|\*|x)$/i.test(version) };
  }
  if (cmd === 'uvx' || cmd === 'pipx') {
    const rest = cmd === 'pipx' && args[0] === 'run' ? args.slice(1) : args;
    const from = rest.indexOf('--from');
    const target = from >= 0 ? rest[from + 1] : firstPositional(rest, ['--with', '-p', '--python', '--index-url']);
    if (!target) return null;
    return { spec: target, pinned: /(==|@)[0-9]/.test(target) };
  }
  if (cmd === 'docker' || cmd === 'podman') {
    const runIdx = args.indexOf('run');
    if (runIdx === -1) return null;
    const img = firstPositional(args.slice(runIdx + 1), DOCKER_OPTIONS_WITH_VALUE);
    if (!img) return null;
    const pinned = img.includes('@sha256:') || (/:[^/]+$/.test(img) && !/:latest$/.test(img));
    return { spec: img, pinned };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------------------------

const SHELLS = new Set(['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh']);

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function isLocalHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

/** Same scheme, host and path; only the query string or fragment differs. */
function queryOnly(x: string | undefined, y: string | undefined): boolean {
  if (!x || !y) return false;
  try {
    const u = new URL(x);
    const v = new URL(y);
    return u.origin === v.origin && u.pathname === v.pathname;
  } catch {
    return false;
  }
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Security-relevant checks that apply to the head state of a server (new or modified). */
function headChecks(file: string, s: McpServer, onlyNew: { env: Set<string>; headers: Set<string>; args: boolean; url: boolean; command: boolean }): Finding[] {
  const out: Finding[] = [];
  const f = (rule: string, severity: Severity, message: string): void => {
    out.push({ rule, severity, category: 'mcp', file, message: `server '${s.name}': ${message}`, side: 'head' });
  };
  for (const [k, v] of Object.entries(s.env)) {
    if (onlyNew.env.has(k) && isLiteralSecret(k, v)) f('mcp-secret-literal', 'high', `env '${k}' contains a literal credential ${redact(v)}; use an environment reference instead`);
  }
  for (const [k, v] of Object.entries(s.headers)) {
    if (onlyNew.headers.has(k) && isLiteralSecret(k, v)) f('mcp-secret-literal', 'high', `header '${k}' contains a literal credential ${redact(v)}; use an environment reference instead`);
  }
  if (onlyNew.args && s.args.some(argHasSecret)) f('mcp-secret-literal', 'high', 'a command-line argument contains a literal credential (value redacted)');
  if (onlyNew.url && s.url) {
    try {
      const u = new URL(s.url);
      const leaked = u.username || u.password || [...u.searchParams].some(([k, v]) => isLiteralSecret(k, v));
      if (leaked) f('mcp-secret-literal', 'high', `url ${redactUrl(s.url)} embeds credentials`);
      if (u.protocol === 'http:' && !isLocalHost(s.url)) f('mcp-insecure-transport', 'medium', `url ${redactUrl(s.url)} is plain http to a non-local host`);
    } catch {
      /* ignore unparsable urls */
    }
  }
  if (onlyNew.command || onlyNew.args) {
    const pkg = packageSpec(s);
    if (pkg && !pkg.pinned) f('mcp-unpinned-package', 'medium', `runs '${pkg.spec}' without a pinned version, so upstream changes execute on your machine unreviewed`);
    const cmd = baseCommand(s.command);
    if (SHELLS.has(cmd) && s.args.some((a) => a === '-c' || a === '/c' || a === '-Command' || a === '-command')) {
      const joined = s.args.join(' ');
      const dl = /\b(curl|wget|iwr|Invoke-WebRequest)\b/i.test(joined) && /\|\s*(ba|z)?sh\b|\biex\b/i.test(joined);
      f('mcp-shell-wrapper', dl ? 'high' : 'medium', dl ? 'launched through a shell that downloads and executes remote code' : `launched through a shell wrapper (${cmd} -c ...), which hides what really runs`);
    }
  }
  return out;
}

export function diffServers(file: string, before: Map<string, McpServer>, after: Map<string, McpServer>): Finding[] {
  const out: Finding[] = [];
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const name of names) {
    const a = before.get(name);
    const b = after.get(name);
    const f = (rule: string, severity: Severity, message: string, side: 'base' | 'head' = 'head'): void => {
      out.push({ rule, severity, category: 'mcp', file, message: `server '${name}': ${message}`, side });
    };
    if (!a && b) {
      f('mcp-server-added', b.disabled ? 'low' : 'high', `added (${describeServer(b)})${b.disabled ? ' [disabled]' : ''}`);
      out.push(
        ...headChecks(file, b, { env: new Set(Object.keys(b.env)), headers: new Set(Object.keys(b.headers)), args: true, url: true, command: true }),
      );
      if (b.approvals.length > 0) f('mcp-auto-approve', 'high', `tools are auto-approved (${b.approvals.join('; ')})`);
      continue;
    }
    if (a && !b) {
      f('mcp-server-removed', 'low', `removed (was ${describeServer(a)})`, 'base');
      continue;
    }
    if (!a || !b) continue;

    const commandChanged = a.command !== b.command;
    const argsChanged = !sameList(a.args, b.args);
    const urlChanged = a.url !== b.url;
    if (commandChanged) f('mcp-command-changed', 'high', `command changed: ${a.command ?? '(none)'} → ${b.command ?? '(none)'}`);
    if (argsChanged) {
      const pa = packageSpec(a);
      const pb = packageSpec(b);
      if (pa && pb && pa.spec !== pb.spec) {
        f('mcp-package-changed', pa.spec.replace(/@[^@/]*$/, '') === pb.spec.replace(/@[^@/]*$/, '') ? 'medium' : 'high', `package changed: ${pa.spec} → ${pb.spec}`);
      } else {
        f('mcp-args-changed', 'medium', `arguments changed: ${a.args.map(redactArg).join(' ')} → ${b.args.map(redactArg).join(' ')}`);
      }
    }
    if (urlChanged) {
      const ha = a.url ? hostOf(a.url) : undefined;
      const hb = b.url ? hostOf(b.url) : undefined;
      f('mcp-url-changed', ha !== hb ? 'high' : queryOnly(a.url, b.url) ? 'low' : 'medium', `url changed: ${a.url ? redactUrl(a.url) : '(none)'} → ${b.url ? redactUrl(b.url) : '(none)'}${ha !== hb ? ' (different host)' : ''}`);
    }
    if (a.transport !== b.transport) f('mcp-transport-changed', 'medium', `transport changed: ${a.transport} → ${b.transport}`);

    const newEnv = new Set<string>();
    for (const [k, v] of Object.entries(b.env)) {
      if (!(k in a.env)) {
        newEnv.add(k);
        f('mcp-env-added', 'medium', `env '${k}' added`);
      } else if (a.env[k] !== v) {
        newEnv.add(k);
        f('mcp-env-changed', 'low', `env '${k}' value changed (value not shown)`);
      }
    }
    for (const k of Object.keys(a.env)) if (!(k in b.env)) f('mcp-env-removed', 'low', `env '${k}' removed`, 'base');

    const newHeaders = new Set<string>();
    for (const [k, v] of Object.entries(b.headers)) {
      if (!(k in a.headers)) {
        newHeaders.add(k);
        f('mcp-header-added', 'medium', `header '${k}' added`);
      } else if (a.headers[k] !== v) {
        newHeaders.add(k);
        f('mcp-header-changed', 'low', `header '${k}' value changed (value not shown)`);
      }
    }
    for (const k of Object.keys(a.headers)) if (!(k in b.headers)) f('mcp-header-removed', 'low', `header '${k}' removed`, 'base');

    const oldAppr = new Set(a.approvals);
    const newAppr = b.approvals.filter((x) => !oldAppr.has(x));
    if (newAppr.length > 0) f('mcp-auto-approve', 'high', `auto-approval widened (${newAppr.join('; ')})`);
    if (a.disabled && !b.disabled) f('mcp-server-enabled', 'high', 'previously disabled server is now enabled');
    if (!a.disabled && b.disabled) f('mcp-server-disabled', 'info', 'server disabled');

    out.push(...headChecks(file, b, { env: newEnv, headers: newHeaders, args: argsChanged, url: urlChanged, command: commandChanged }));
  }
  return out;
}
