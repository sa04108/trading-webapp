import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error 일반 JavaScript 스크립트는 별도 선언 파일 없이 테스트에서 직접 가져온다.
import { listVersions, parseDigest, parseImage, runRetention } from '../../scripts/publish-agent-image.mjs';

const hash = (raw: string) => `sha256:${createHash('sha256').update(raw).digest('hex')}`;
const leaf = (marker: string) => JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: hash(marker), size: 1 }, layers: [] });
const index = (...digests: string[]) => JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: digests.map(digest => ({ digest, mediaType: 'application/vnd.oci.image.manifest.v1+json', size: 1 })) });
const version = (digest: string, tags: string[] = []) => ({ id: digest, name: digest, metadata: { container: { tags } } });

function fixture({ latest, previous, manifests, versions, cliNewline = false }: { latest?: string; previous?: string; manifests: Record<string, string>; versions?: ReturnType<typeof version>[]; cliNewline?: boolean }) {
  const allVersions = versions ?? Object.keys(manifests).map(d => version(d, [d === latest ? 'latest' : '', d === previous ? 'previous' : ''].filter(Boolean)));
  const deleted: string[] = [];
  const tagged: Array<[string, string]> = [];
  const inspected: string[] = [];
  const docker = {
    inspect: vi.fn((_image: string, digest: string) => { inspected.push(digest); const raw = manifests[digest]; if (!raw) throw new Error(`missing ${digest}`); return raw + (cliNewline ? '\n' : ''); }),
    tag: vi.fn((_image: string, digest: string, tag: string) => { tagged.push([tag, digest]); }),
    resolve: vi.fn((_image: string, tag: string) => {
      const digest = tagged.find(([name]) => name === tag)?.[1] ?? (tag === 'latest' ? latest : previous);
      return manifests[digest!] + (cliNewline ? '\n' : '');
    }),
  };
  const run = (mode: 'promote' | 'prune-only', digest?: string, remove = async (id: string) => { deleted.push(id); }) => runRetention({
    mode, digest, image: 'ghcr.io/acme/quant-agent', owner: 'acme', repository: 'acme/app', token: 'secret',
    versionsFn: async () => allVersions, docker, removeVersion: remove,
  });
  return { run, deleted, tagged, inspected, docker, allVersions };
}

describe('agent image retention', () => {
  it('validates the image and digest contract', () => {
    expect(parseImage('ghcr.io/acme/quant-agent')).toBe('ghcr.io/acme/quant-agent');
    expect(() => parseImage('ghcr.io/acme/quant-agent:latest')).toThrow();
    expect(() => parseImage('docker.io/acme/quant-agent')).toThrow();
    expect(() => parseImage('ghcr.io/Acme/quant-agent')).toThrow();
    expect(() => parseImage('ghcr.io/acme/quant agent')).toThrow();
    expect(() => parseDigest('sha256:bad')).toThrow();
  });

  it('paginates package versions until the final partial page', async () => {
    const request = vi.fn(async (url: string) => url.includes('/users/')
      ? { type: 'Organization' }
      : Number(new URL(url).searchParams.get('page')) === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }]);
    const values = await listVersions({ owner: 'acme', repository: 'acme/app', token: 'secret', request });
    expect(values).toHaveLength(101);
    expect(request.mock.calls.map(([url]) => url).filter(url => url.includes('/packages/'))).toHaveLength(2);
  });

  it('retains the recursive multiarch closure of latest and previous releases', async () => {
    const amd = hash(leaf('amd64'));
    const arm = hash(leaf('arm64'));
    const oldChild = hash(leaf('old'));
    const candidate = hash(index(amd, arm));
    const old = hash(index(oldChild));
    const unrelated = hash(leaf('orphan'));
    const f = fixture({ latest: old, manifests: { [amd]: leaf('amd64'), [arm]: leaf('arm64'), [oldChild]: leaf('old'), [candidate]: index(amd, arm), [old]: index(oldChild), [unrelated]: leaf('orphan') }, versions: [version(candidate), version(amd), version(arm), version(old, ['latest']), version(oldChild), version(unrelated)] });
    const result = await f.run('promote', candidate);
    expect(result.retainedDigests).toEqual(new Set([candidate, amd, arm, old, oldChild]));
    expect(f.deleted).toEqual([unrelated]);
    expect(f.tagged).toEqual([['previous', old], ['latest', candidate]]);
  });

  it('accepts only a single CLI-added newline while verifying inspect and promoted tag bytes', async () => {
    const current = hash(leaf('first'));
    const f = fixture({ manifests: { [current]: leaf('first') }, versions: [version(current)], cliNewline: true });
    await f.run('promote', current);
    expect(f.tagged).toEqual([['latest', current]]);
  });

  it('rejects malformed indexes and missing reachable package versions before tag changes or deletion', async () => {
    const malformed = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] });
    const malformedDigest = hash(malformed);
    const bad = fixture({ manifests: { [malformedDigest]: malformed }, versions: [version(malformedDigest)] });
    await expect(bad.run('promote', malformedDigest)).rejects.toThrow('Invalid OCI index');
    expect(bad.tagged).toEqual([]);
    expect(bad.deleted).toEqual([]);

    const child = hash(leaf('child'));
    const root = hash(index(child));
    const incomplete = fixture({ manifests: { [root]: index(child), [child]: leaf('child') }, versions: [version(root)] });
    await expect(incomplete.run('promote', root)).rejects.toThrow('Reachable manifest missing');
    expect(incomplete.tagged).toEqual([]);
    expect(incomplete.deleted).toEqual([]);
  });

  it('does not change tags or delete versions when child inspection fails', async () => {
    const child = hash(leaf('child'));
    const root = hash(index(child));
    const f = fixture({ manifests: { [root]: index(child) }, versions: [version(root), version(child)] });
    await expect(f.run('promote', root)).rejects.toThrow(`missing ${child}`);
    expect(f.tagged).toEqual([]);
    expect(f.deleted).toEqual([]);
  });

  it('keeps previous unchanged when promoting the same latest digest again', async () => {
    const child = hash(leaf('child'));
    const current = hash(index(child));
    const previous = hash(leaf('previous'));
    const f = fixture({ latest: current, previous, manifests: { [current]: index(child), [child]: leaf('child'), [previous]: leaf('previous') } });
    await f.run('promote', current);
    expect(f.tagged).toEqual([['previous', previous], ['latest', current]]);
    expect(f.deleted).toEqual([]);
  });

  it('supports first release with latest and no previous backup', async () => {
    const first = hash(leaf('first'));
    const orphan = hash(leaf('orphan'));
    const f = fixture({ manifests: { [first]: leaf('first'), [orphan]: leaf('orphan') }, versions: [version(first), version(orphan)] });
    const result = await f.run('promote', first);
    expect(result.previous).toBeNull();
    expect(f.tagged).toEqual([['latest', first]]);
    expect(f.deleted).toEqual([orphan]);
  });

  it('does not delete anything when candidate inspection fails', async () => {
    const candidate = hash(leaf('candidate'));
    const f = fixture({ manifests: {}, versions: [version(candidate), version(hash(leaf('orphan')))] });
    await expect(f.run('promote', candidate)).rejects.toThrow('missing');
    expect(f.deleted).toEqual([]);
    expect(f.tagged).toEqual([]);
  });

  it('refuses prune without a known latest and reports API deletion failures', async () => {
    const lone = hash(leaf('lone'));
    const f = fixture({ manifests: { [lone]: leaf('lone') }, versions: [version(lone)] });
    await expect(f.run('prune-only')).rejects.toThrow('known latest');
    const orphan = hash(leaf('orphan'));
    const latest = fixture({ latest: lone, manifests: { [lone]: leaf('lone'), [orphan]: leaf('orphan') }, versions: [version(lone, ['latest']), version(orphan)] });
    await expect(latest.run('prune-only', undefined, async () => { throw new Error('API 403'); })).rejects.toThrow('API 403');
  });
});
