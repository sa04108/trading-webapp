import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';

export function parseDigest(value) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`Invalid image digest: ${value}`);
  return value;
}

export function parseImage(value) {
  const match = /^(ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*)$/.exec(value ?? '');
  if (!match) throw new Error('AGENT_IMAGE must be an untagged ghcr.io/<owner>/<package> image');
  return match[1];
}

export async function requestJson(url, token, options = {}) {
  const response = await globalThis.fetch(url, { ...options, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...options.headers } });
  if (!response.ok) throw new Error(`GitHub API ${options.method ?? 'GET'} ${url} failed (${response.status}): ${await response.text()}`);
  if (response.status === 204) return null;
  return response.json();
}

export async function listVersions({ owner, repository, token, packageName = 'quant-agent', request = requestJson }) {
  const account = await request(`${API}/users/${encodeURIComponent(owner)}`, token);
  const ownerType = account.type === 'Organization' ? 'orgs' : account.type === 'User' ? 'users' : null;
  if (!ownerType) throw new Error('GitHub owner type is not User or Organization');
  const repositoryOwner = encodeURIComponent(owner);
  const repoOwner = repository.split('/')[0];
  if (repoOwner.toLowerCase() !== owner.toLowerCase()) throw new Error('GITHUB_REPOSITORY owner does not match package owner');
  const versions = [];
  for (let page = 1; ; page += 1) {
    const pageItems = await request(`${API}/${ownerType}/${repositoryOwner}/packages/container/${encodeURIComponent(packageName)}/versions?per_page=100&page=${page}`, token);
    if (!Array.isArray(pageItems)) throw new Error('Unexpected package versions response');
    versions.push(...pageItems);
    if (pageItems.length < 100) return versions;
  }
}

function digestOfVersion(version) {
  const digest = version?.name;
  return typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : null;
}

function verifyManifestDigest(raw, expected) {
  const direct = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  if (direct === expected) return raw;
  if (raw.endsWith('\n')) {
    const withoutCliLf = raw.slice(0, -1);
    if (`sha256:${createHash('sha256').update(withoutCliLf).digest('hex')}` === expected) return withoutCliLf;
  }
  throw new Error(`Manifest digest mismatch for ${expected} (received ${direct})`);
}

const INDEX_TYPES = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
const MANIFEST_TYPES = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);

function validateDescriptor(descriptor, label) {
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.mediaType !== 'string' || !Number.isInteger(descriptor.size) || descriptor.size < 0) throw new Error(`Invalid ${label} descriptor`);
  parseDigest(descriptor.digest);
}

function validateManifest(manifest, digest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.schemaVersion !== 2 || typeof manifest.mediaType !== 'string') throw new Error(`Invalid OCI manifest at ${digest}`);
  if (INDEX_TYPES.has(manifest.mediaType)) {
    if (!Array.isArray(manifest.manifests) || manifest.manifests.length === 0) throw new Error(`Invalid OCI index at ${digest}`);
    for (const child of manifest.manifests) validateDescriptor(child, 'index child');
    return manifest.manifests;
  }
  if (!MANIFEST_TYPES.has(manifest.mediaType) || !manifest.config || !Array.isArray(manifest.layers)) throw new Error(`Invalid image manifest at ${digest}`);
  validateDescriptor(manifest.config, 'config');
  for (const layer of manifest.layers) validateDescriptor(layer, 'layer');
  return [];
}

export function createDockerAdapter(exec = execFileSync) {
  return {
    inspect: (image, ref) => exec('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${image}@${ref}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    resolve: (image, tag) => exec('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${image}:${tag}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    tag: (image, digest, tag) => exec('docker', ['buildx', 'imagetools', 'create', '--tag', `${image}:${tag}`, `${image}@${digest}`], { stdio: 'inherit' }),
  };
}

export async function runRetention({ mode, digest, image, owner, repository, token, versionsFn = listVersions, docker = createDockerAdapter(), removeVersion, log = () => {} }) {
  image = parseImage(image);
  if (image.split('/')[1].toLowerCase() !== owner.toLowerCase()) throw new Error('AGENT_IMAGE owner does not match GITHUB_REPOSITORY_OWNER');
  const versions = await versionsFn({ owner, repository, token });
  const latestVersions = versions.filter(v => v.metadata?.container?.tags?.includes('latest'));
  const previousVersions = versions.filter(v => v.metadata?.container?.tags?.includes('previous'));
  if (latestVersions.length > 1 || previousVersions.length > 1) throw new Error('Package has duplicate latest or previous tags');
  const currentLatest = latestVersions[0];
  const currentPrevious = previousVersions[0];
  const candidate = mode === 'promote' ? parseDigest(digest) : null;
  if (mode !== 'promote' && mode !== 'prune-only') throw new Error('Expected --promote <digest> or --prune-only');
  if (mode === 'promote' && !versions.some(v => digestOfVersion(v) === candidate)) throw new Error(`Candidate digest is absent from package versions: ${candidate}`);
  if (currentLatest && digestOfVersion(currentLatest) == null) throw new Error('Current latest version has an invalid digest');
  if (currentPrevious && digestOfVersion(currentPrevious) == null) throw new Error('Current previous version has an invalid digest');
  if (mode === 'prune-only' && !currentLatest) throw new Error('Refusing cleanup without a known latest tag');
  if (mode === 'promote' && !currentLatest && currentPrevious) throw new Error('Refusing promotion with previous tag but no latest tag');
  const latest = mode === 'promote' ? candidate : digestOfVersion(currentLatest);
  const prior = mode === 'promote'
    ? (digestOfVersion(currentLatest) && digestOfVersion(currentLatest) !== candidate ? digestOfVersion(currentLatest) : digestOfVersion(currentPrevious))
    : digestOfVersion(currentPrevious);
  const protectedDigests = new Set([latest, prior].filter(Boolean));
  const byDigest = new Map(versions.map(v => [digestOfVersion(v), v]).filter(([d]) => d));
  for (const protectedDigest of protectedDigests) if (!byDigest.has(protectedDigest)) throw new Error(`Protected digest missing from package versions: ${protectedDigest}`);

  const closure = new Set();
  const visiting = new Set();
  const walk = (d) => {
    if (closure.has(d)) return;
    if (visiting.has(d)) throw new Error(`Recursive OCI manifest cycle at ${d}`);
    visiting.add(d);
    const raw = verifyManifestDigest(docker.inspect(image, d), d);
    const children = validateManifest(JSON.parse(raw), d);
    for (const child of children) walk(parseDigest(child.digest));
    visiting.delete(d);
    closure.add(d);
  };
  for (const d of protectedDigests) walk(d);
  for (const d of closure) if (!byDigest.has(d)) throw new Error(`Reachable manifest missing from package versions: ${d}`);

  if (mode === 'promote') {
    if (prior) docker.tag(image, prior, 'previous');
    else if (currentPrevious && digestOfVersion(currentPrevious) !== latest) throw new Error('Inconsistent previous tag state');
    docker.tag(image, latest, 'latest');
    for (const [tag, expected] of [['latest', latest], ...(prior ? [['previous', prior]] : [])]) {
      verifyManifestDigest(docker.resolve(image, tag), expected);
    }
  }
  const retained = new Set([...closure]);
  const deletions = versions.filter(v => !retained.has(digestOfVersion(v)));
  if (!removeVersion) throw new Error('A package-version delete adapter is required');
  for (const version of deletions) await removeVersion(version.id);
  log(`Published ${latest}; retained ${retained.size} reachable manifests and removed ${deletions.length} unrelated versions.`);
  return { latest, previous: prior ?? null, retainedDigests: retained, deletedIds: deletions.map(v => v.id) };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const mode = argv[0] === '--promote' ? 'promote' : argv[0] === '--prune-only' ? 'prune-only' : null;
  if (!mode || (mode === 'promote' && argv.length !== 2) || (mode === 'prune-only' && argv.length !== 1)) throw new Error('Usage: publish-agent-image.mjs --promote <sha256:digest> | --prune-only');
  const image = parseImage(env.AGENT_IMAGE);
  const token = env.GH_TOKEN;
  if (!token || !env.GITHUB_ACTOR || !env.GITHUB_REPOSITORY || !env.GITHUB_REPOSITORY_OWNER) throw new Error('GH_TOKEN, GITHUB_ACTOR, GITHUB_REPOSITORY, and GITHUB_REPOSITORY_OWNER are required');
  const request = (url, apiToken, options) => requestJson(url, apiToken, options);
  const packageName = image.split('/')[2];
  const versionsFn = args => listVersions({ ...args, packageName, request });
  const removeVersion = async id => {
    const [repoOwner] = env.GITHUB_REPOSITORY.split('/');
    const account = await request(`${API}/users/${encodeURIComponent(env.GITHUB_REPOSITORY_OWNER)}`, token);
    const kind = account.type === 'Organization' ? 'orgs' : account.type === 'User' ? 'users' : null;
    if (!kind) throw new Error('GitHub owner type is not User or Organization');
    await requestJson(`${API}/${kind}/${encodeURIComponent(repoOwner)}/packages/container/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(id)}`, token, { method: 'DELETE' });
  };
  return runRetention({ mode, digest: argv[1], image, owner: env.GITHUB_REPOSITORY_OWNER, repository: env.GITHUB_REPOSITORY, token, versionsFn, removeVersion, log: message => process.stdout.write(`${message}\n`) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
