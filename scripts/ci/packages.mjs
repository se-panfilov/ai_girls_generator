// Select packages for GitHub Actions and check the `package` choice lists in the workflows.
// Usage: node scripts/ci/packages.mjs check
//        PACKAGE=<all|directory> DRY_RUN=<true|false> node scripts/ci/packages.mjs select
//        EVENT=pull_request BASE_SHA=<sha> HEAD_SHA=<sha> DRY_RUN=false node scripts/ci/packages.mjs select
import { assertWorkflows, changedPackages, check, isDryRun, listPackages, lockfilePackages, main, output, run, safe, selectPackages, summary } from './lib.mjs';

const objectName = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// Read the files that a pull request changes. `--no-renames` lists both paths of a moved file.
function pullRequestChanges(baseSha, headSha, packages) {
  if (!objectName.test(baseSha) || !objectName.test(headSha)) throw new Error('BASE_SHA and HEAD_SHA must be full commit object names.');
  const mergeBase = check('git', ['merge-base', baseSha, headSha]).trim();
  const files = check('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', mergeBase, headSha]).split('\0').filter(Boolean);
  const lockfile = files.includes('package-lock.json') ? lockfilePackages(readLock(mergeBase), readLock(headSha), packages) : undefined;
  return changedPackages(files, packages, lockfile);
}

// A missing or invalid lockfile returns undefined. Then the lockfile counts as a shared file.
function readLock(commit) {
  const result = run('git', ['show', `${commit}:package-lock.json`]);
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

await main(() => {
  const mode = process.argv[2];
  const packages = listPackages();
  assertWorkflows(packages);
  if (mode === 'check') {
    console.log(`The package lists in GitHub Actions agree with packages/: ${packages.map((item) => item.dir).join(', ') || 'no packages'}.`);
    return;
  }
  if (mode !== 'select' || process.argv.length !== 3) throw new Error('Usage: packages.mjs check | select');
  const dryRun = isDryRun(process.env.DRY_RUN);
  // A pull request keeps every package in the matrix, so each required `test (…)` check reports a result.
  // The test job skips its steps for packages that the pull request does not change.
  let matrix;
  let selected;
  let reason;
  if (process.env.EVENT === 'pull_request') {
    const result = pullRequestChanges(process.env.BASE_SHA ?? '', process.env.HEAD_SHA ?? '', packages);
    matrix = packages;
    selected = result.packages;
    reason =
      result.shared === undefined ? (selected.length === packages.length ? 'all packages changed' : 'only these packages changed') : `shared file changed: ${safe(result.shared).replace(/`/g, "'")}`;
  } else {
    selected = selectPackages(process.env.PACKAGE || 'all', packages);
    matrix = selected;
  }
  output(
    'packages',
    matrix.map(({ dir, name }) => ({ dir, name }))
  );
  output(
    'selected',
    selected.map(({ dir }) => dir)
  );
  output('dry_run', String(dryRun));
  const lines = selected.length ? selected.map((item) => `- \`${item.dir}\` → \`${safe(item.name)}@${item.version}\``) : ['- No package in packages/.'];
  const title = `Selected packages${dryRun ? ' (dry run)' : ''}${reason ? `: ${reason}` : ''}`;
  console.log(`${title}\n${lines.join('\n')}`);
  summary(`### ${title}\n\n${lines.join('\n')}\n`);
});
