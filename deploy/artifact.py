#!/usr/bin/env python3
"""Package one checked build, or verify every served file against that artifact."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
import urllib.error
import urllib.parse
import urllib.request


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def pack(dist, bundle, commit):
    dist, bundle = Path(dist), Path(bundle)
    if not re.fullmatch('[0-9a-f]{40}', commit):
        raise ValueError('invalid commit')
    bundle.mkdir(parents=True, exist_ok=True)
    files = {}
    with tarfile.open(bundle / 'dist.tgz', 'w:gz') as tar:
        for path in sorted(dist.rglob('*')):
            if path.is_symlink():
                raise ValueError('build contains a symlink')
            if path.is_file():
                relative = path.relative_to(dist).as_posix()
                files[relative] = sha256(path.read_bytes())
                tar.add(path, arcname=relative, recursive=False)
    if 'index.html' not in files:
        raise ValueError('build has no index.html')
    manifest = {'commit': commit, 'archive_sha256': sha256((bundle / 'dist.tgz').read_bytes()), 'files': files}
    (bundle / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Packaged {len(files)} checked files for {commit}')


def load(bundle, commit):
    bundle = Path(bundle)
    manifest = json.loads((bundle / 'manifest.json').read_text())
    if not re.fullmatch('[0-9a-f]{40}', commit) or manifest['commit'] != commit:
        raise ValueError('artifact is not for the checked commit')
    if sha256((bundle / 'dist.tgz').read_bytes()) != manifest['archive_sha256']:
        raise ValueError('artifact archive checksum mismatch')
    return manifest


def verify(bundle, commit, base, host_header=None):
    manifest = load(bundle, commit)

    def fetch(path):
        headers = {'Cache-Control': 'no-cache'}
        if host_header:
            headers['Host'] = host_header
        request = urllib.request.Request(base.rstrip('/') + '/' + urllib.parse.quote(path), headers=headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise ValueError('unexpected status for ' + path)
            content_type = response.headers.get_content_type()
            expected_types = {'.html': {'text/html'}, '.js': {'application/javascript', 'text/javascript'},
                              '.css': {'text/css'}, '.png': {'image/png'}}
            expected = expected_types.get(PurePosixPath(path).suffix)
            if expected and content_type not in expected:
                raise ValueError('wrong content type for ' + path + ': ' + content_type)
            return response.read()

    if fetch('REVISION').decode().strip() != commit:
        raise ValueError('public revision is not the checked commit')
    if fetch('ARTIFACT_SHA256').decode().strip() != manifest['archive_sha256']:
        raise ValueError('served archive identity differs from checked artifact')
    for path, expected in manifest['files'].items():
        if sha256(fetch(path)) != expected:
            raise ValueError('public checksum mismatch: ' + path)
        print('Verified bytes and content type:', path)
    try:
        fetch('assets/slotrush-missing-negative-control.js')
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    else:
        raise ValueError('missing asset did not return 404')
    print('Verified revision, archive identity and missing-asset 404')


if __name__ == '__main__':
    try:
        if len(sys.argv) == 5 and sys.argv[1] == 'pack':
            pack(*sys.argv[2:])
        elif len(sys.argv) in (5, 6) and sys.argv[1] == 'verify':
            verify(*sys.argv[2:])
        else:
            raise ValueError('usage: artifact.py pack <dist> <bundle> <commit> | verify <bundle> <commit> <base-url> [Host]')
    except (ValueError, OSError, KeyError, tarfile.TarError) as error:
        print('artifact:', str(error), file=sys.stderr)
        sys.exit(1)
