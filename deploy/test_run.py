"""Subprocess regressions for the real Bash orchestrator; no network or secrets."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

import slotrush_receive as receiver
from test_receiver import archive


# The transport mock uses the real receiver and its lock on a temporary site.
PEER = r'''
import fcntl, json, os, pathlib, signal, sys, time
sys.path.insert(0, os.environ['DEPLOY_MODULES'])
import slotrush_receive as receiver
root = pathlib.Path(os.environ['MOCK_ROOT'])
mode = os.environ.get('MOCK_MODE', '')
kind = pathlib.Path(sys.argv[0]).name
with (root / 'calls').open('a') as log:
    log.write(json.dumps([kind] + sys.argv[1:]) + '\n')
if kind == 'curl':
    sys.exit(0)
if kind == 'timeout':
    args = sys.argv[1:]
    if 'verify' in args and mode == 'verify_timeout':
        args = ['0.3s' if x == '120s' else x for x in args]
    os.execv(os.environ['REAL_TIMEOUT'], ['timeout'] + args)
if kind == 'python3':
    if len(sys.argv) > 2 and sys.argv[1:3] == ['deploy/artifact.py', 'verify']:
        (root / 'verifying').touch()
        if mode in ('term', 'int', 'verify_timeout'):
            time.sleep(30)
        if mode in ('verify_fail', 'unrelated', 'guard_race', 'unreachable', 'rollback_disconnect'):
            sys.exit(1)
        sys.exit(0)
    os.execv(sys.executable, [sys.executable] + sys.argv[1:])
command = sys.argv[-1].split()
site = receiver.Site(root / 'site')
with (site.root / '.deploy.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    if command[0] == 'deploy':
        if len(command) == 4:
            name = site.deploy(command[1], command[2], sys.stdin.buffer, name=command[3])
        else:
            name = site.deploy(command[1], command[2], sys.stdin.buffer)
        (root / 'candidate').write_text(name)
        if mode == 'unrelated':
            # A second publisher replaces our candidate before recovery.
            import io, hashlib
            from test_receiver import archive
            data = archive()
            other = site.deploy('c' * 40, hashlib.sha256(data).hexdigest(), io.BytesIO(data))
            (root / 'unrelated').write_text(other)
        if mode == 'ssh255':
            sys.exit(255)  # publication succeeded, acknowledgement was lost
        print('deployed', name)
    elif command[0] == 'status':
        if mode == 'unreachable' and (root / 'candidate').exists():
            sys.exit(255)
        print(json.dumps(site.status()))
    elif command[0] == 'rollback-if':
        if mode == 'guard_race':
            import io, hashlib
            from test_receiver import archive
            data = archive()
            other = site.deploy('c' * 40, hashlib.sha256(data).hexdigest(), io.BytesIO(data))
            (root / 'unrelated').write_text(other)
        print('rolled back', site.rollback_if(command[1], command[2]))
        if mode == 'rollback_disconnect':
            sys.exit(255)
    elif command[0] == 'rollback':
        print('rolled back', site.rollback(command[1]))
    else:
        sys.exit(2)
'''


class RunTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.repo = Path(__file__).resolve().parent.parent
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        import shutil
        real_timeout = shutil.which('timeout')
        self.assertIsNotNone(real_timeout)
        assert real_timeout is not None
        for name in ('ssh', 'curl', 'python3', 'timeout'):
            path = self.bin / name
            path.write_text('#!' + sys.executable + '\n' + PEER)
            path.chmod(0o755)
        self.site = receiver.Site(self.root / 'site')
        self.data = archive()
        self.checksum = hashlib.sha256(self.data).hexdigest()
        import io
        self.old = self.site.deploy('a' * 40, self.checksum, io.BytesIO(self.data))
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir()
        (self.bundle / 'dist.tgz').write_bytes(self.data)
        (self.bundle / 'manifest.json').write_text(json.dumps({
            'commit': 'b' * 40, 'archive_sha256': self.checksum, 'files': {}}))
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                        GITHUB_SHA='b' * 40, SLOTRUSH_KEY_FILE='unused-key',
                        SLOTRUSH_HOSTS_FILE='unused-hosts', MOCK_ROOT=str(self.root),
                        DEPLOY_MODULES=str(self.repo / 'deploy'), REAL_TIMEOUT=real_timeout)

    def run_deploy(self, mode='', send_signal=None):
        env = dict(self.env, MOCK_MODE=mode)
        process = subprocess.Popen(['bash', 'deploy/run.sh', str(self.bundle)], cwd=self.repo,
                                   env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        try:
            if send_signal is not None:
                deadline = time.monotonic() + 5
                while not (self.root / 'verifying').exists():
                    if process.poll() is not None or time.monotonic() >= deadline:
                        self.fail('verification did not start')
                    time.sleep(0.01)
                process.send_signal(send_signal)
            stdout, stderr = process.communicate(timeout=8)
            return process.returncode, stdout, stderr
        finally:
            # Also reap mocks if a regression leaves them behind.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()

    def test_success_keeps_verified_candidate_without_rollback(self):
        code, stdout, stderr = self.run_deploy()
        self.assertEqual(code, 0, stderr)
        candidate = (self.root / 'candidate').read_text()
        self.assertEqual(self.site.current(), candidate)
        self.assertEqual(json.loads(stdout.split('deployed ' + candidate)[-1])['current'], candidate)
        self.assertNotIn('rollback-if', (self.root / 'calls').read_text())

    def test_verification_failure_restores_exact_captured_old(self):
        code, stdout, stderr = self.run_deploy('verify_fail')
        self.assertNotEqual(code, 0)
        self.assertEqual(self.site.current(), self.old, stderr)
        self.assertIn('Restored captured old release: ' + self.old, stderr)

    def test_sigint_during_verification_restores_old(self):
        code, stdout, stderr = self.run_deploy('int', signal.SIGINT)
        self.assertEqual(code, 130, stderr)
        self.assertEqual(self.site.current(), self.old, stderr)

    def test_unrelated_current_release_is_never_rolled_back(self):
        code, stdout, stderr = self.run_deploy('unrelated')
        self.assertNotEqual(code, 0)
        self.assertEqual(self.site.current(), (self.root / 'unrelated').read_text(), stderr)
        self.assertNotIn('rollback-if', (self.root / 'calls').read_text())
        self.assertIn('unrelated current release untouched', stderr)

    def test_publisher_racing_after_status_is_not_rolled_back(self):
        code, stdout, stderr = self.run_deploy('guard_race')
        self.assertNotEqual(code, 0)
        self.assertEqual(self.site.current(), (self.root / 'unrelated').read_text(), stderr)
        self.assertIn('RECOVERY UNCONFIRMED', stderr)

    def test_unreachable_recovery_reports_failure_not_restoration(self):
        code, stdout, stderr = self.run_deploy('unreachable')
        self.assertNotEqual(code, 0)
        self.assertEqual(self.site.current(), (self.root / 'candidate').read_text())
        self.assertIn('RECOVERY UNCONFIRMED', stderr)
        self.assertNotIn('Restored captured', stderr)

    def test_lost_rollback_acknowledgement_is_reconciled(self):
        code, stdout, stderr = self.run_deploy('rollback_disconnect')
        self.assertNotEqual(code, 0)
        self.assertEqual(self.site.current(), self.old, stderr)
        self.assertIn('acknowledgement lost', stderr)
        self.assertIn('Restored captured old release', stderr)

    def test_verification_has_global_deadline_and_restores_old(self):
        code, stdout, stderr = self.run_deploy('verify_timeout')
        self.assertNotEqual(code, 0)
        self.assertEqual(self.site.current(), self.old, stderr)
        calls = [json.loads(line) for line in (self.root / 'calls').read_text().splitlines()]
        verification = [call for call in calls if call[0] == 'timeout' and 'verify' in call]
        self.assertEqual(len(verification), 1)
        self.assertIn('120s', verification[0])
        self.assertIn('--kill-after=5s', verification[0])

    def test_sigterm_during_verification_restores_old_without_waiting_for_verifier(self):
        code, stdout, stderr = self.run_deploy('term', signal.SIGTERM)
        self.assertNotEqual(code, 0)
        self.assertEqual(self.site.current(), self.old, stderr)

    def test_lost_deploy_acknowledgement_restores_exact_old_release(self):
        code, stdout, stderr = self.run_deploy('ssh255')
        self.assertNotEqual(code, 0)
        self.assertTrue((self.root / 'candidate').exists(), stderr)
        self.assertEqual(self.site.current(), self.old, stderr)


if __name__ == '__main__':
    unittest.main()
