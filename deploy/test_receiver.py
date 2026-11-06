"""Run with python3 -m unittest discover -s deploy -p 'test_*.py'."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

import slotrush_receive as receiver


def archive(files=None):
    files = files or {
        'index.html': b'<title>Slot Rush GP</title><script src="./assets/game.js"></script><link rel="stylesheet" href="./assets/game.css"><link rel="icon" href="./favicon.png">',
        'assets/game.js': b'console.info("game");',
        'assets/game.css': b'body { color: red; }',
        'favicon.png': b'PNG',
    }
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as tar:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
    return output.getvalue()


class ReceiverTest(unittest.TestCase):
    def test_pax_metadata_is_bounded_before_tar_headers_are_parsed(self):
        with tempfile.TemporaryDirectory() as directory:
            site = receiver.Site(directory)
            data = archive()
            first = site.deploy('a' * 40, hashlib.sha256(data).hexdigest(), io.BytesIO(data))
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w:gz', format=tarfile.PAX_FORMAT,
                              pax_headers={'comment': 'x' * (2 * 1024 * 1024)}) as tar:
                with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as original:
                    for member in original:
                        tar.addfile(member, original.extractfile(member))
            bad = output.getvalue()
            with mock.patch.object(receiver, 'MAX_EXPANDED', 1024):
                with self.assertRaisesRegex(ValueError, 'expanded'):
                    site.deploy('b' * 40, hashlib.sha256(bad).hexdigest(), io.BytesIO(bad))
            self.assertEqual(site.current(), first)
            self.assertEqual(list(site.releases.glob('.incoming.*')), [])

    def test_log_failure_does_not_publish_current(self):
        with tempfile.TemporaryDirectory() as directory:
            site = receiver.Site(directory)
            data = archive()
            checksum = hashlib.sha256(data).hexdigest()
            first = site.deploy('a' * 40, checksum, io.BytesIO(data))
            (site.root / 'deploy.log').unlink()
            (site.root / 'deploy.log').mkdir()
            with self.assertRaises(OSError):
                site.deploy('b' * 40, checksum, io.BytesIO(data))
            self.assertEqual(site.current(), first)

    def test_forced_command_dispatch_supports_guarded_recovery_not_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            site = receiver.Site(directory)
            data = archive()
            checksum = hashlib.sha256(data).hexdigest()
            old = site.deploy('a' * 40, checksum, io.BytesIO(data))
            candidate = '20260101T000000000001Z-' + 'b' * 12
            def command(value, payload=b''):
                return subprocess.run(
                    [sys.executable, '-c', 'import sys; from pathlib import Path; '
                     'import slotrush_receive as r; r.ROOT=Path(sys.argv[1]); r.main()', directory],
                    input=payload, capture_output=True, timeout=5,
                    env=dict(os.environ, PYTHONPATH=str(Path(__file__).parent.resolve()),
                             SSH_ORIGINAL_COMMAND=value))
            deployed = command(f'deploy {"b" * 40} {checksum} {candidate}', data)
            self.assertEqual(deployed.returncode, 0, deployed.stderr)
            status = json.loads(command('status').stdout)
            self.assertEqual(status['current'], candidate)
            self.assertEqual(status['revision'], 'b' * 40)
            rolled_back = command(f'rollback-if {candidate} {old}')
            self.assertEqual(rolled_back.returncode, 0, rolled_back.stderr)
            self.assertEqual(site.current(), old)
            self.assertNotEqual(command(f'rollback-if {candidate} {old}').returncode, 0)
            self.assertNotEqual(command('sh -c id').returncode, 0)
            self.assertEqual(site.current(), old)

    def test_named_candidate_and_guarded_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            site = receiver.Site(directory)
            data = archive()
            checksum = hashlib.sha256(data).hexdigest()
            old = site.deploy('a' * 40, checksum, io.BytesIO(data))
            candidate = '20260101T000000000001Z-' + 'b' * 12
            self.assertEqual(site.deploy('b' * 40, checksum, io.BytesIO(data), name=candidate), candidate)
            status = site.status()
            self.assertEqual(status['revision'], 'b' * 40)
            self.assertEqual(status['artifact_sha256'], checksum)
            site.rollback_if(candidate, old)
            self.assertEqual(site.current(), old)
            unrelated = site.deploy('c' * 40, checksum, io.BytesIO(data))
            with self.assertRaisesRegex(ValueError, 'current'):
                site.rollback_if(candidate, old)
            self.assertEqual(site.current(), unrelated)
            with self.assertRaises((ValueError, OSError)):
                site.deploy('b' * 40, checksum, io.BytesIO(data), name=candidate)
            self.assertEqual(site.current(), unrelated)
            with self.assertRaises(ValueError):
                site.deploy('b' * 40, checksum, io.BytesIO(data), name='../../escape')

    def test_deploy_and_atomic_rollback_preserve_previous_release(self):
        receiver = Path(__file__).with_name('slotrush_receive.py')
        self.assertTrue(receiver.exists(), 'The restricted release receiver must exist')
        spec = importlib.util.spec_from_file_location('receiver', receiver)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            site = module.Site(Path(directory))
            data = archive()
            checksum = hashlib.sha256(data).hexdigest()
            first = site.deploy('a' * 40, checksum, io.BytesIO(data))
            second = site.deploy('b' * 40, checksum, io.BytesIO(data))
            self.assertEqual(site.current(), second)
            self.assertEqual((Path(directory) / 'current/REVISION').read_text().strip(), 'b' * 40)
            site.rollback()
            self.assertEqual(site.current(), first)
            site.rollback()
            self.assertEqual(site.current(), second)
            self.assertTrue((Path(directory) / 'releases' / first / 'index.html').is_file())

    def test_invalid_archives_never_change_current(self):
        receiver = Path(__file__).with_name('slotrush_receive.py')
        spec = importlib.util.spec_from_file_location('receiver', receiver)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            site = module.Site(Path(directory))
            data = archive()
            first = site.deploy('a' * 40, hashlib.sha256(data).hexdigest(), io.BytesIO(data))
            bad_archives = [archive({'../escape': b'bad'}), archive({'/escape': b'bad'}),
                            archive({'index.html': b'<title>no assets</title>'})]
            linked = io.BytesIO()
            with tarfile.open(fileobj=linked, mode='w:gz') as tar:
                member = tarfile.TarInfo('escape')
                member.type = tarfile.SYMTYPE
                member.linkname = '/etc/passwd'
                tar.addfile(member)
            bad_archives.append(linked.getvalue())
            for bad in bad_archives:
                with self.subTest(size=len(bad)), self.assertRaises((ValueError, OSError)):
                    site.deploy('b' * 40, hashlib.sha256(bad).hexdigest(), io.BytesIO(bad))
                self.assertEqual(site.current(), first)
            with self.assertRaisesRegex(ValueError, 'checksum'):
                site.deploy('b' * 40, '0' * 64, io.BytesIO(data))
            setattr(module, 'MAX_EXPANDED', 10)
            with self.assertRaisesRegex(ValueError, 'expanded'):
                site.deploy('b' * 40, hashlib.sha256(data).hexdigest(), io.BytesIO(data))
            self.assertEqual(site.current(), first)
            self.assertEqual(list((Path(directory) / 'releases').glob('.incoming.*')), [])
            with self.assertRaises(ValueError):
                site.rollback('../../etc')


if __name__ == '__main__':
    unittest.main()
