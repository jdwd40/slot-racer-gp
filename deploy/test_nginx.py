"""Static checks of the site's Nginx files: site-level gzip for static assets, never for /api/ or /ws."""
from pathlib import Path
import re
import unittest

NGINX = Path(__file__).resolve().parent / 'nginx'
STATIC = NGINX / 'slotrush.jdwd40.com.conf'
ONLINE = NGINX / 'slotrush.jdwd40.com.online.conf'
GZIP = [
    'gzip_types text/css application/javascript application/json image/svg+xml;',
    'gzip_vary on;',
    'gzip_comp_level 5;',
    'gzip_min_length 1024;',
]


def blocks(text, header):
    """Bodies of every `header {...}` block, matched by braces; comments stripped."""
    text = re.sub(r'#[^\n]*', '', text)
    out = []
    for m in re.finditer(header + r'\s*\{', text):
        depth, i = 1, m.end()
        while depth:
            depth += {'{': 1, '}': -1}.get(text[i], 0)
            i += 1
        out.append(text[m.end():i - 1])
    return out


def top_level(body):
    """Directives of a block body, excluding anything inside nested blocks."""
    flat, depth = [], 0
    for ch in body:
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
        elif depth == 0:
            flat.append(ch)
    return [' '.join(d.split()) + ';' for d in ''.join(flat).split(';') if d.strip()]


def tls_server(path):
    servers = [b for b in blocks(path.read_text(), r'\bserver') if re.search(r'^\s*listen 443 ssl;', b, re.M)]
    assert len(servers) == 1, path
    return servers[0]


class GzipConfig(unittest.TestCase):
    def test_tls_blocks_compress_static_assets(self):
        for path in (STATIC, ONLINE):
            with self.subTest(path.name):
                directives = top_level(tls_server(path))
                for want in GZIP:
                    self.assertIn(want, directives)
                # the host's http {} supplies `gzip on`; this site file never touches shared config
                self.assertNotIn('gzip off;', directives)

    def test_http_redirect_blocks_unchanged(self):
        for path in (STATIC, ONLINE):
            for body in blocks(path.read_text(), r'\bserver'):
                if 'listen 80;' in body:
                    self.assertNotIn('gzip', body)

    def test_online_api_and_ws_are_never_compressed(self):
        server = tls_server(ONLINE)
        for loc in (r'location /api/', r'location = /ws'):
            with self.subTest(loc):
                (body,) = blocks(server, loc)
                directives = top_level(body)
                self.assertIn('gzip off;', directives)
        (api,) = blocks(server, r'location /api/')
        self.assertIn('proxy_set_header Accept-Encoding "";', top_level(api))
        (ws,) = blocks(server, r'location = /ws')
        self.assertIn('proxy_set_header Sec-WebSocket-Extensions "";', top_level(ws))

    def test_static_rollback_has_no_proxy_routes(self):
        text = STATIC.read_text()
        self.assertNotIn('proxy_pass', text)
        self.assertNotRegex(text, r'location[^{]*/(api|ws)')


if __name__ == '__main__':
    unittest.main()
