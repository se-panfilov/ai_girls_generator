// Shared Git and pull request rules from AGENTS.md and docs/WRITING.md. Git hooks and the pr-rules CI job use them.

export const protectedBranches = ['master', 'main'];
export const branchTypes = ['feature', 'bugfix', 'docs', 'refactor', 'test', 'chore'];
// <type>/<short_description>: a known prefix and lowercase English words separated by underscores.
export const branchPattern = new RegExp(`^(${branchTypes.join('|')})/[a-z0-9]+(?:_[a-z0-9]+)*$`);
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Links to AI agent threads, chats, sessions, and tasks, by host name and path prefix.
// Product pages without a conversation are not matched.
export const aiLinkHosts = {
  'claude.ai': /^\/(code\/(session_|project\/)|chat\/|share\/|project\/)/i,
  'chatgpt.com': /^\/(c\/|share\/|codex\/tasks\/|g\/[^/]+\/c\/)/i,
  'chat.openai.com': /^\/(c\/|share\/)/i,
  'gemini.google.com': /^\/(app|share)\//i,
  'g.co': /^\/gemini\/share\//i,
  'jules.google.com': /^\/(session|task)\//i,
  'copilot.microsoft.com': /^\/(chats|shares)\//i,
  'github.com': /^\/copilot\/(c|share)\//i,
  'cursor.com': /^\/agents(\/|$)/i,
  'chat.mistral.ai': /^\/chat\//i,
  'perplexity.ai': /^\/search\//i
};
// A link with or without a scheme: a host name with at least one dot and a path.
const linkCandidate = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"'`)\]]*/gi;

export function hasAiLink(text) {
  for (const [candidate] of text.matchAll(linkCandidate)) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^www\./, '');
    const path = aiLinkHosts[host];
    if (path?.test(url.pathname)) return true;
  }
  return false;
}
// Commit trailers that identify an agent session, for example `Claude-Session:`.
export const sessionTrailer = /^[A-Za-z0-9-]*Session:\s*\S/im;

// Return the problems for a commit message or pull request text. The text itself is never repeated.
export function aiLinkProblems(text, label) {
  const problems = [];
  if (hasAiLink(text)) problems.push(`${label}: contains a link to an AI agent discussion. Describe the reason in the text.`);
  if (sessionTrailer.test(text)) problems.push(`${label}: contains an agent session trailer (for example, Claude-Session:). Remove it.`);
  return problems;
}

// Dependabot cannot change its `dependabot/` branch prefix or use the description template.
// GitHub sets the author login, and a person cannot use it. The branch prefix alone is not sufficient.
export const dependabotLogin = 'dependabot[bot]';
export function isDependabotPullRequest(author, branch) {
  return author === dependabotLogin && branch.startsWith('dependabot/');
}

export function branchProblems(name) {
  if (protectedBranches.includes(name)) return [`The branch ${name} is protected. Create a task branch <type>/<short_description>.`];
  if (!branchPattern.test(name))
    return [`The branch name must be <type>/<short_description>. The type is ${branchTypes.join(', ')}. The description has lowercase words separated by _. Example: bugfix/fix_atlas_paths.`];
  return [];
}

// The first heading must be `## tl;dr`. HTML comments and one italic attribution line may precede it.
const isOneLineComment = (line) => line.startsWith('<!--') && line.endsWith('-->') && line.length >= 7;

export function pullRequestBodyProblems(body) {
  const problems = [];
  const lines = body.split(/\r?\n/);
  // Skip empty lines and one-line HTML comments, such as an attribution marker.
  const content = (from) => lines.findIndex((line, index) => index >= from && line.trim() !== '' && !isOneLineComment(line.trim()));
  let start = content(0);
  if (start >= 0 && /^_[^_].*_$/.test(lines[start]?.trim() ?? '')) start = content(start + 1);
  if (start < 0 || lines[start]?.trim() !== '## tl;dr') problems.push('The PR description must start with the heading ## tl;dr.');
  for (const heading of ['## Changes', '## Verification']) {
    if (!lines.some((line) => line.trim() === heading)) problems.push(`The PR description has no ${heading} section from the template.`);
  }
  return problems;
}

// Compare two versions. The result is 'same', 'patch', 'minor', 'major', or 'invalid' for a skipped or reduced version.
export function versionStep(base, head) {
  const left = version.exec(base);
  const right = version.exec(head);
  if (!left || !right) return 'invalid';
  const [, a = '', b = '', c = ''] = left;
  const [, x = '', y = '', z = ''] = right;
  const [major, minor, patch] = [Number(a), Number(b), Number(c)];
  const [nextMajor, nextMinor, nextPatch] = [Number(x), Number(y), Number(z)];
  if (nextMajor === major && nextMinor === minor && nextPatch === patch) return 'same';
  if (nextMajor === major && nextMinor === minor && nextPatch === patch + 1) return 'patch';
  if (nextMajor === major && nextMinor === minor + 1 && nextPatch === 0) return 'minor';
  if (nextMajor === major + 1 && nextMinor === 0 && nextPatch === 0) return 'major';
  return 'invalid';
}

// Files under packages/<dir>/test/ do not change the package behavior, so they do not require a version change.
export function changesPackage(dir, path) {
  return path.startsWith(`packages/${dir}/`) && !path.startsWith(`packages/${dir}/test/`);
}

export function versionProblems(packages, changedFiles) {
  const problems = [];
  for (const item of packages) {
    if (item.baseVersion === undefined) continue;
    const step = versionStep(item.baseVersion, item.version);
    const changed = changedFiles.some((path) => changesPackage(item.dir, path));
    if (step === 'invalid') problems.push(`${item.name}: the version ${item.baseVersion} → ${item.version} must change by exactly one patch, minor, or major step.`);
    else if (changed && step === 'same')
      problems.push(`${item.name}: files in packages/${item.dir} changed. Increase the version once: npm version patch --workspace ${item.name} --no-git-tag-version --ignore-scripts.`);
  }
  return problems;
}

// Packages with an install script that a human reviewed. npm ci --ignore-scripts prevents the script from running.
export const reviewedInstallScripts = ['lefthook'];

// Compare lockfile entries. New or changed packages must come from the npm registry with an integrity value.
export function lockfileChanges(baseLock, headLock) {
  const base = baseLock?.packages ?? {};
  const head = headLock?.packages ?? {};
  const changes = [];
  const problems = [];
  for (const [path, entry] of Object.entries(head)) {
    if (!path.startsWith('node_modules/') && !path.includes('/node_modules/')) continue;
    const previous = base[path];
    if (previous && previous.version === entry.version && previous.resolved === entry.resolved && previous.integrity === entry.integrity) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    changes.push(`${name}@${entry.version ?? '?'}${previous ? ` (was ${previous.version ?? '?'})` : ' (new)'}`);
    if (entry.link === true) continue;
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) problems.push(`package-lock.json: ${name} does not come from https://registry.npmjs.org/.`);
    if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) problems.push(`package-lock.json: ${name} has no sha512 integrity value.`);
    if (entry.hasInstallScript === true && !reviewedInstallScripts.includes(name)) problems.push(`package-lock.json: ${name} has an install script. A human review is necessary.`);
  }
  return { changes, problems };
}
