/** Heuristics for literal credentials. Values are never echoed back; use {@link redact}. */

const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/,
  /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
];

const SECRET_KEY = /(token|secret|passw(or)?d|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|bearer)/i;

/** Replace anything that looks like a known token format with a marker (for safe display). */
export function redactTokens(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '[redacted]');
  }
  return out;
}

export function matchesTokenPattern(value: string): boolean {
  return TOKEN_PATTERNS.some((re) => re.test(value));
}

/** `${VAR}`, `$VAR`, `{env:VAR}`, `%VAR%`, `<your-key>`, `{{x}}`, empty or obvious dummy values. */
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v === '') return true;
  if (/\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\{env:[^}]+\}|%[A-Za-z_][A-Za-z0-9_]*%|\{\{[^}]+\}\}/.test(v)) return true;
  if (/^<[^>]+>$/.test(v)) return true;
  if (/^(your|my)[-_ ]|^(xxx+|changeme|replace[-_ ]?me|todo|example|dummy|placeholder)$/i.test(v)) return true;
  return false;
}

/** Is `value` (stored under `key`) a literal credential committed to the repo? */
export function isLiteralSecret(key: string, value: string): boolean {
  if (isPlaceholder(value)) return false;
  if (matchesTokenPattern(value)) return true;
  return SECRET_KEY.test(key) && value.trim().length >= 8;
}

export function redact(value: string): string {
  return `[redacted ${value.length} chars]`;
}

/** Remove credentials from a URL (userinfo and secret-looking query parameters) for display. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    for (const key of [...u.searchParams.keys()]) {
      const val = u.searchParams.get(key) ?? '';
      if (SECRET_KEY.test(key) || matchesTokenPattern(val)) u.searchParams.set(key, '***');
    }
    return decodeURIComponent(u.toString());
  } catch {
    return matchesTokenPattern(url) ? redact(url) : url;
  }
}

/** Redact `--token=abc` / bare token-looking CLI arguments. */
export function redactArg(arg: string): string {
  const eq = /^(--?[\w-]+)=([\s\S]+)$/.exec(arg);
  if (eq && !isPlaceholder(eq[2] as string) && (SECRET_KEY.test(eq[1] as string) || matchesTokenPattern(eq[2] as string))) {
    return `${eq[1]}=${redact(eq[2] as string)}`;
  }
  if (matchesTokenPattern(arg)) return redact(arg);
  return arg;
}

export function argHasSecret(arg: string): boolean {
  return redactArg(arg) !== arg;
}
