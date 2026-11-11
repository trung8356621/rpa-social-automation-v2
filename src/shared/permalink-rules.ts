import type { PostIdentity } from "./permalink-adapter.js";

export interface UserPermalinkRule {
  id: string;
  name: string;
  platform: "facebook" | "threads" | "generic";
  template: string;
  enabled: boolean;
  isBuiltin?: boolean;
  createdAt?: string;
}

export interface RuleValidationResult {
  valid: boolean;
  error?: string;
  parsedTokens?: string[];
  postIdToken?: string;
  scopeToken?: string;
}

export interface RuleConflict {
  type: "IDENTITY_CONFLICT" | "SHADOWED_RULE";
  conflictingRuleId: string;
  conflictingRuleName: string;
  sampleUrl: string;
  candidatePostId: string;
  existingPostId: string;
  message: string;
}

export interface RuleConflictResult {
  valid: boolean;
  error?: string;
  conflicts: RuleConflict[];
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledParamRule {
  key: string;
  pattern: RegExp;
  tokenNames: string[];
}

export interface CompiledRule {
  id: string;
  name: string;
  platform: "facebook" | "threads" | "generic";
  template: string;
  enabled: boolean;
  isBuiltin: boolean;
  hostPattern: RegExp | null;
  pathPattern: RegExp;
  pathTokenNames: string[];
  paramRules: CompiledParamRule[];
  postIdSource: { type: "path" | "param"; indexOrKey: string | number };
  scopeSource?: { type: "path" | "param"; indexOrKey: string | number };
}

/**
 * Validates a user-supplied permalink template.
 * Template MUST contain `{postId}` token.
 * No regex or code execution required.
 */
export function validateRuleTemplate(template: string): RuleValidationResult {
  if (!template || typeof template !== "string") {
    return { valid: false, error: "Template cannot be empty" };
  }
  const trimmed = template.trim();
  if (!trimmed) {
    return { valid: false, error: "Template cannot be empty" };
  }

  const tokenMatches = [...trimmed.matchAll(/\{([a-zA-Z0-9_-]+)\}/g)];
  if (tokenMatches.length === 0) {
    return { valid: false, error: "Template must contain at least one {variable} token, including {postId}" };
  }

  const tokens = tokenMatches.map(m => m[1]);
  if (!tokens.includes("postId")) {
    return { valid: false, error: "Template must contain {postId} token to extract post identity" };
  }

  const scopeToken = tokens.find(t => ["scope", "groupId", "username", "idorvanity", "ownerId", "id"].includes(t));

  return {
    valid: true,
    parsedTokens: tokens,
    postIdToken: "postId",
    scopeToken,
  };
}

/**
 * Compiles a user-supplied template into safe RegExps without eval or new Function.
 */
export function compileRule(rule: UserPermalinkRule): CompiledRule | null {
  const validation = validateRuleTemplate(rule.template);
  if (!validation.valid) return null;

  const trimmed = rule.template.trim();
  let urlObj: URL;
  let hasHost = false;

  try {
    if (/^https?:\/\//i.test(trimmed)) {
      urlObj = new URL(trimmed);
      hasHost = true;
    } else {
      urlObj = new URL(trimmed, "https://example.com");
      hasHost = false;
    }
  } catch {
    return null;
  }

  let hostPattern: RegExp | null = null;
  if (hasHost) {
    const host = urlObj.hostname.toLowerCase();
    hostPattern = new RegExp(`(?:^|\\.)${escapeRegExp(host)}$`, "i");
  }

  // Compile pathname pattern (decode %7B/%7D created by WHATWG URL on curly braces)
  let rawPath = decodeURIComponent(urlObj.pathname);
  if (rawPath.length > 1 && rawPath.endsWith("/")) {
    rawPath = rawPath.slice(0, -1);
  }
  const pathTokenNames: string[] = [];
  const pathParts = rawPath.split("/").map(seg => {
    if (!seg) return "";
    let compiledSeg = "";
    let lastIndex = 0;
    const re = /\{([a-zA-Z0-9_-]+)\}/g;
    let match: RegExpExecArray | null;

    while ((match = re.exec(seg)) !== null) {
      const before = seg.slice(lastIndex, match.index);
      compiledSeg += escapeRegExp(before);
      pathTokenNames.push(match[1]);
      compiledSeg += "([0-9a-zA-Z._-]+)";
      lastIndex = re.lastIndex;
    }
    compiledSeg += escapeRegExp(seg.slice(lastIndex));
    return compiledSeg;
  });

  const pathPatternStr = "^" + pathParts.join("\\/") + "\\/?$";
  const pathPattern = new RegExp(pathPatternStr, "i");

  // Compile query params
  const paramRules: CompiledParamRule[] = [];
  let postIdSource: CompiledRule["postIdSource"] | null = null;
  let scopeSource: CompiledRule["scopeSource"] | undefined;

  const postIdPathIdx = pathTokenNames.indexOf("postId");
  if (postIdPathIdx !== -1) {
    postIdSource = { type: "path", indexOrKey: postIdPathIdx };
  }
  const scopePathIdx = pathTokenNames.findIndex(t => ["scope", "groupId", "username", "ownerId"].includes(t));
  if (scopePathIdx !== -1) {
    scopeSource = { type: "path", indexOrKey: scopePathIdx };
  }

  for (const [key, valueTemplate] of urlObj.searchParams.entries()) {
    const tokenNames: string[] = [];
    let compiledVal = "";
    let lastIdx = 0;
    const re = /\{([a-zA-Z0-9_-]+)\}/g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(valueTemplate)) !== null) {
      compiledVal += escapeRegExp(valueTemplate.slice(lastIdx, m.index));
      tokenNames.push(m[1]);
      compiledVal += "([0-9a-zA-Z._-]+)";
      lastIdx = re.lastIndex;
    }
    compiledVal += escapeRegExp(valueTemplate.slice(lastIdx));
    const paramRegex = new RegExp(`^${compiledVal}$`, "i");

    paramRules.push({
      key,
      pattern: paramRegex,
      tokenNames,
    });

    if (tokenNames.includes("postId")) {
      postIdSource = { type: "param", indexOrKey: key };
    }
    if (tokenNames.some(t => ["scope", "groupId", "username", "idorvanity", "ownerId", "id"].includes(t))) {
      scopeSource = { type: "param", indexOrKey: key };
    }
  }

  if (!postIdSource) return null;

  return {
    id: rule.id,
    name: rule.name,
    platform: rule.platform,
    template: rule.template,
    enabled: rule.enabled,
    isBuiltin: Boolean(rule.isBuiltin),
    hostPattern,
    pathPattern,
    pathTokenNames,
    paramRules,
    postIdSource,
    scopeSource,
  };
}

/**
 * Matches an URL against a compiled rule.
 * Pure deterministic pattern matching; no eval or untrusted code execution.
 */
export function matchCompiledRule(
  compiled: CompiledRule,
  href: string,
  basePageUrl = "https://www.facebook.com/",
): PostIdentity | null {
  if (!compiled.enabled || !href || typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("javascript:")) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, basePageUrl);
  } catch {
    return null;
  }

  if (compiled.hostPattern && !compiled.hostPattern.test(parsed.hostname)) {
    return null;
  }

  const pathMatch = compiled.pathPattern.exec(parsed.pathname);
  if (!pathMatch) return null;

  const tokenValues = new Map<string, string>();
  for (let i = 0; i < compiled.pathTokenNames.length; i++) {
    const tokenName = compiled.pathTokenNames[i];
    const val = pathMatch[i + 1];
    if (val) tokenValues.set(tokenName, val);
  }

  for (const pr of compiled.paramRules) {
    const actualVal = parsed.searchParams.get(pr.key);
    if (!actualVal) return null;
    const m = pr.pattern.exec(actualVal.trim());
    if (!m) return null;
    for (let i = 0; i < pr.tokenNames.length; i++) {
      const tokenName = pr.tokenNames[i];
      const val = m[i + 1];
      if (val) tokenValues.set(tokenName, val);
    }
  }

  const postId = tokenValues.get("postId");
  if (!postId) return null;

  const scope =
    tokenValues.get("scope") ||
    tokenValues.get("groupId") ||
    tokenValues.get("username") ||
    tokenValues.get("idorvanity") ||
    tokenValues.get("ownerId") ||
    parsed.searchParams.get("idorvanity") ||
    undefined;

  let canonicalUrl = "";
  if (compiled.platform === "facebook") {
    canonicalUrl = scope
      ? `https://www.facebook.com/groups/${scope}/posts/${postId}`
      : `https://www.facebook.com/permalink.php?story_fbid=${postId}`;
  } else if (compiled.platform === "threads") {
    canonicalUrl = scope
      ? `https://www.threads.net/${scope.startsWith("@") ? scope : `@${scope}`}/post/${postId}`
      : `https://www.threads.net/post/${postId}`;
  } else {
    canonicalUrl = parsed.origin + parsed.pathname;
  }

  return {
    platform: compiled.platform,
    postId,
    scope,
    canonicalUrl,
    rawUrl: trimmed,
  };
}

/**
 * Builtin default rules mirroring existing Facebook and Threads permalink adapters.
 */
export const BUILTIN_PERMALINK_RULES: UserPermalinkRule[] = [
  {
    id: "builtin_fb_group_post",
    name: "Facebook Group Post",
    platform: "facebook",
    template: "https://www.facebook.com/groups/{groupId}/posts/{postId}",
    enabled: true,
    isBuiltin: true,
  },
  {
    id: "builtin_fb_group_permalink",
    name: "Facebook Group Permalink",
    platform: "facebook",
    template: "https://www.facebook.com/groups/{groupId}/permalink/{postId}",
    enabled: true,
    isBuiltin: true,
  },
  {
    id: "builtin_fb_photo_gm",
    name: "Facebook Photo with gm.{postId}",
    platform: "facebook",
    template: "https://www.facebook.com/photo/?fbid={photoId}&set=gm.{postId}",
    enabled: true,
    isBuiltin: true,
  },
  {
    id: "builtin_fb_photo_pcb",
    name: "Facebook Photo with pcb.{postId}",
    platform: "facebook",
    template: "https://www.facebook.com/photo/?fbid={photoId}&set=pcb.{postId}",
    enabled: true,
    isBuiltin: true,
  },
  {
    id: "builtin_fb_legacy_permalink",
    name: "Facebook Legacy Permalink (permalink.php)",
    platform: "facebook",
    template: "https://www.facebook.com/permalink.php?story_fbid={postId}&id={ownerId}",
    enabled: true,
    isBuiltin: true,
  },
  {
    id: "builtin_fb_story_link",
    name: "Facebook Story Link (story.php)",
    platform: "facebook",
    template: "https://www.facebook.com/story.php?story_fbid={postId}&id={ownerId}",
    enabled: true,
    isBuiltin: true,
  },
  {
    id: "builtin_threads_post",
    name: "Threads Post",
    platform: "threads",
    template: "https://www.threads.net/@{username}/post/{postId}",
    enabled: true,
    isBuiltin: true,
  },
];

/**
 * Checks for conflicts between a new candidate rule and existing active rules.
 */
export function detectRuleConflict(
  candidateRule: UserPermalinkRule,
  existingRules: UserPermalinkRule[],
  sampleUrls: string[],
): RuleConflictResult {
  const validation = validateRuleTemplate(candidateRule.template);
  if (!validation.valid) {
    return { valid: false, error: validation.error, conflicts: [] };
  }

  const compiledCandidate = compileRule(candidateRule);
  if (!compiledCandidate) {
    return { valid: false, error: "Could not compile candidate template", conflicts: [] };
  }

  const activeCompiledExisting = existingRules
    .filter(r => r.enabled && r.id !== candidateRule.id)
    .map(r => compileRule(r))
    .filter((c): c is CompiledRule => c !== null);

  const conflicts: RuleConflict[] = [];

  for (const url of sampleUrls) {
    const candidateMatch = matchCompiledRule(compiledCandidate, url);
    if (!candidateMatch) continue;

    for (const existing of activeCompiledExisting) {
      const existingMatch = matchCompiledRule(existing, url);
      if (!existingMatch) continue;

      if (existingMatch.postId !== candidateMatch.postId) {
        conflicts.push({
          type: "IDENTITY_CONFLICT",
          conflictingRuleId: existing.id,
          conflictingRuleName: existing.name,
          sampleUrl: url,
          candidatePostId: candidateMatch.postId,
          existingPostId: existingMatch.postId,
          message: `Candidate rule conflicts with '${existing.name}' (${existing.id}): extracts '${candidateMatch.postId}' while existing rule extracts '${existingMatch.postId}'`,
        });
      } else {
        conflicts.push({
          type: "SHADOWED_RULE",
          conflictingRuleId: existing.id,
          conflictingRuleName: existing.name,
          sampleUrl: url,
          candidatePostId: candidateMatch.postId,
          existingPostId: existingMatch.postId,
          message: `Candidate rule matches the same URL as '${existing.name}' (${existing.id}) with identical postId '${candidateMatch.postId}'`,
        });
      }
    }
  }

  return {
    valid: true,
    conflicts,
  };
}

/**
 * Registry holding builtin and user-defined rules.
 */
export class PermalinkRuleRegistry {
  private rules: Map<string, UserPermalinkRule> = new Map();
  private compiledCache: Map<string, CompiledRule> = new Map();

  constructor(initialRules: UserPermalinkRule[] = BUILTIN_PERMALINK_RULES) {
    for (const r of initialRules) {
      this.registerRule(r);
    }
  }

  registerRule(rule: UserPermalinkRule): boolean {
    const validation = validateRuleTemplate(rule.template);
    if (!validation.valid) return false;
    const compiled = compileRule(rule);
    if (!compiled) return false;
    this.rules.set(rule.id, { ...rule });
    this.compiledCache.set(rule.id, compiled);
    return true;
  }

  getRules(platform?: string): UserPermalinkRule[] {
    const list = [...this.rules.values()];
    if (!platform || platform === "generic") return list;
    return list.filter(r => r.platform === platform || r.platform === "generic");
  }

  getRule(id: string): UserPermalinkRule | undefined {
    return this.rules.get(id);
  }

  toggleRule(id: string, enabled: boolean): boolean {
    const r = this.rules.get(id);
    if (!r) return false;
    r.enabled = enabled;
    const c = this.compiledCache.get(id);
    if (c) c.enabled = enabled;
    return true;
  }

  deleteRule(id: string): boolean {
    const r = this.rules.get(id);
    if (!r || r.isBuiltin) return false; // Do not delete builtin rules
    this.rules.delete(id);
    this.compiledCache.delete(id);
    return true;
  }

  match(href: string, basePageUrl?: string): { identity: PostIdentity; ruleId: string } | null {
    for (const [id, compiled] of this.compiledCache.entries()) {
      if (!compiled.enabled) continue;
      const identity = matchCompiledRule(compiled, href, basePageUrl);
      if (identity) {
        return { identity, ruleId: id };
      }
    }
    return null;
  }

  exportJson(): string {
    return JSON.stringify([...this.rules.values()], null, 2);
  }

  importJson(json: string): number {
    try {
      const parsed = JSON.parse(json) as UserPermalinkRule[];
      let imported = 0;
      for (const r of parsed) {
        if (this.registerRule(r)) imported++;
      }
      return imported;
    } catch {
      return 0;
    }
  }
}
