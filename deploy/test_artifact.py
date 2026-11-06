import functools
import http.server
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


class ArtifactTest(unittest.TestCase):
    def test_pack_then_verify_checks_all_bytes_not_just_status(self):
        script = Path(__file__).with_name('artifact.py')
        self.assertTrue(script.exists(), 'Artifact pack/verification tool must exist')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dist = root / 'dist'
            dist.mkdir()
            (dist / 'index.html').write_text('<title>Slot Rush GP</title>')
            (dist / 'game.js').write_text('alert(1)')
            bundle = root / 'bundle'
            sha = 'a' * 40
            result = subprocess.run([sys.executable, str(script), 'pack', str(dist), str(bundle), sha], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            (dist / 'REVISION').write_text(sha + '\n')
            manifest = json.loads((bundle / 'manifest.json').read_text())
            (dist / 'ARTIFACT_SHA256').write_text(manifest['archive_sha256'] + '\n')
            handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(dist))
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f'http://127.0.0.1:{server.server_port}'
                args = [sys.executable, str(script), 'verify', str(bundle), sha, url]
                result = subprocess.run(args, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                (dist / 'game.js').write_text('wrong bytes')
                result = subprocess.run(args, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('game.js', result.stderr)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
