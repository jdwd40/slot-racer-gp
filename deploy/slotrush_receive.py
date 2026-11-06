#!/usr/bin/python3
"""Root-owned forced SSH command; runs without sudo as slotrush-deploy."""
import datetime
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import sys
import tarfile
import tempfile

ROOT = Path('/srv/www/slotrush.jdwd40.com')
NAME = re.compile(r'[0-9]{8}T[0-9]{6}(?:[0-9]{6})?Z-[0-9a-f]{12}')
MAX_ARCHIVE = 50 * 1024 * 1024
MAX_EXPANDED = 100 * 1024 * 1024
MAX_ENTRIES = 1000


class Site:
    def __init__(self, root):
        self.root = Path(root)
        self.releases = self.root / 'releases'
        self.releases.mkdir(parents=True, exist_ok=True)

    def current(self, link='current'):
        path = self.root / link
        if not path.is_symlink():
            return None
        target = os.readlink(path)
        name = Path(target).name
        if target != 'releases/' + name or not NAME.fullmatch(name):
            raise ValueError('invalid release symlink')
        return name

    def link(self, name, link):
        temporary = self.root / ('.' + link + '.tmp')
        temporary.unlink(missing_ok=True)
        temporary.symlink_to('releases/' + name)
        os.replace(temporary, self.root / link)

    def switch(self, name):
        old = self.current()
        if old == name:
            raise ValueError('release is already live')
        if old:
            self.link(old, 'previous')
        # Log an intent before publication. Even close/flush errors must leave
        # current untouched; no fallible bookkeeping follows its atomic replace.
        with (self.root / 'deploy.log').open('a') as log:
            log.write(f'{datetime.datetime.now(datetime.timezone.utc).isoformat()} switch-intent {old} -> {name}\n')
        self.link(name, 'current')

    def deploy(self, sha, checksum, stream, name=None):
        if not re.fullmatch('[0-9a-f]{40}', sha) or not re.fullmatch('[0-9a-f]{64}', checksum):
            raise ValueError('invalid commit or SHA256')
        if name is not None and (not NAME.fullmatch(name) or not name.endswith('-' + sha[:12])):
            raise ValueError('invalid candidate release name')
        if name is not None and (self.releases / name).exists():
            raise ValueError('candidate release already exists')
        with tempfile.TemporaryDirectory(prefix='.incoming.', dir=self.releases) as directory:
            work = Path(directory)
            packed = work / 'dist.tgz'
            total = 0
            digest = hashlib.sha256()
            with packed.open('wb') as output:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_ARCHIVE:
                        raise ValueError('archive too large')
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != checksum:
                raise ValueError('archive checksum mismatch')
            # Bound the entire decompressed stream BEFORE tarfile sees any header:
            # PAX/GNU extension payloads and tar padding are not yielded as members.
            unpacked = work / 'dist.tar'
            with gzip.open(packed, 'rb') as source, unpacked.open('xb') as output:
                expanded = 0
                while True:
                    chunk = source.read(min(1024 * 1024, MAX_EXPANDED - expanded + 1))
                    if not chunk:
                        break
                    expanded += len(chunk)
                    if expanded > MAX_EXPANDED:
                        raise ValueError('expanded archive too large')
                    output.write(chunk)
            release = work / 'release'
            release.mkdir()
            # Never use extractall: reject links/special files and copy only bounded,
            # validated regular files. No tar paths can escape this staging tree.
            with tarfile.open(unpacked, 'r:') as tar:
                expanded = 0
                seen = set()
                count = 0
                for member in tar:
                    count += 1
                    if count > MAX_ENTRIES:
                        raise ValueError('too many archive entries')
                    path = PurePosixPath(member.name)
                    if path.is_absolute() or '..' in path.parts or any(ord(c) < 32 for c in member.name):
                        raise ValueError('unsafe archive path')
                    if not (member.isfile() or member.isdir()):
                        raise ValueError('links and special files are forbidden')
                    if str(path) == '.' and member.isdir():
                        continue
                    if str(path) in seen or str(path) in ('REVISION', 'ARTIFACT_SHA256'):
                        raise ValueError('duplicate or reserved archive path')
                    seen.add(str(path))
                    expanded += member.size
                    if expanded > MAX_EXPANDED or member.size < 0:
                        raise ValueError('expanded archive too large')
                    destination = release.joinpath(*path.parts)
                    if member.isdir():
                        destination.mkdir(parents=True, exist_ok=True)
                        destination.chmod(0o755)
                    else:
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        source = tar.extractfile(member)
                        if source is None:
                            raise ValueError('unreadable archive member')
                        with source, destination.open('xb') as output:
                            shutil.copyfileobj(source, output)
                        destination.chmod(0o644)
            html = (release / 'index.html').read_text()
            refs = re.findall(r'(?:src|href)=[\"\']\./([^\"\']+)[\"\']', html)
            if not any(x.endswith('.js') for x in refs) or not any(x.endswith('.css') for x in refs):
                raise ValueError('index must reference JavaScript and CSS')
            for ref in refs + ['favicon.png']:
                path = PurePosixPath(ref)
                if path.is_absolute() or '..' in path.parts or not release.joinpath(*path.parts).is_file():
                    raise ValueError('missing or unsafe page asset')
            (release / 'REVISION').write_text(sha + '\n')
            (release / 'ARTIFACT_SHA256').write_text(checksum + '\n')
            now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            name = name or now + '-' + sha[:12]
            os.rename(release, self.releases / name)
            self.switch(name)
            return name

    def rollback(self, name=None):
        if name is None:
            name = self.current('previous')
        if not name or not NAME.fullmatch(name):
            raise ValueError('no valid previous/selected release')
        if not (self.releases / name / 'index.html').is_file():
            raise ValueError('release missing or incomplete')
        self.switch(name)
        return name

    def rollback_if(self, candidate, target):
        # main holds the same lock for this comparison and the switch: a status
        # query followed by an unconditional rollback would have a TOCTOU race.
        if not NAME.fullmatch(candidate) or self.current() != candidate:
            raise ValueError('current release is not the expected candidate')
        return self.rollback(target)

    def status(self):
        current = self.current()
        def metadata(filename):
            path = self.releases / current / filename if current else None
            return path.read_text().strip() if path and path.is_file() else None
        return {'current': current, 'previous': self.current('previous'),
                'revision': metadata('REVISION'), 'artifact_sha256': metadata('ARTIFACT_SHA256'),
                'releases': sorted(p.name for p in self.releases.iterdir() if NAME.fullmatch(p.name) and p.is_dir())}


def main():
    os.umask(0o022)
    args = shlex.split(os.environ['SSH_ORIGINAL_COMMAND']) if 'SSH_ORIGINAL_COMMAND' in os.environ else sys.argv[1:]
    site = Site(ROOT)
    with (ROOT / '.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if len(args) in (3, 4) and args[0] == 'deploy':
            print('deployed', site.deploy(args[1], args[2], sys.stdin.buffer,
                                          args[3] if len(args) == 4 else None))
        elif len(args) == 3 and args[0] == 'rollback-if':
            print('rolled back', site.rollback_if(args[1], args[2]))
        elif len(args) in (1, 2) and args[0] == 'rollback':
            print('rolled back', site.rollback(args[1] if len(args) == 2 else None))
        elif args == ['status']:
            print(json.dumps(site.status(), indent=2))
        else:
            raise ValueError('allowed: deploy <40-hex SHA> <64-hex SHA256> [candidate], '
                             'rollback [release], rollback-if <candidate> <target>, status')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, tarfile.TarError, EOFError) as error:
        print('slotrush-receive:', str(error), file=sys.stderr)
        sys.exit(1)
