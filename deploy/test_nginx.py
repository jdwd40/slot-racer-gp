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

    def test_locations_with_add_header_repeat_the_security_headers(self):
        # nginx drops every server-level add_header in a location that has one of its own
        server = tls_server(ONLINE)
        wanted = [d for d in top_level(server) if d.startswith('add_header ')]
        self.assertEqual(len(wanted), 3)
        for loc in re.findall(r'location[^{]*\{', server):
            for body in blocks(server, re.escape(loc[:-1].rstrip())):
                directives = top_level(body)
                if any(d.startswith('add_header ') for d in directives):
                    with self.subTest(loc):
                        for d in wanted:
                            self.assertIn(d, directives)

    def test_api_hides_the_room_servers_copies_of_headers_it_adds(self):
        # the room server sends its own Cache-Control and X-Content-Type-Options; /api/ adds both, so the upstream copies are
        # hidden and each header reaches the browser once (#94, #106)
        (api,) = blocks(tls_server(ONLINE), r'location /api/')
        directives = top_level(api)
        for name in ('Cache-Control', 'X-Content-Type-Options'):
            with self.subTest(name):
                self.assertIn(f'proxy_hide_header {name};', directives)
                self.assertTrue(any(d.startswith(f'add_header {name} ') for d in directives), name)

    def test_static_rollback_has_no_proxy_routes(self):
        text = STATIC.read_text()
        self.assertNotIn('proxy_pass', text)
        self.assertNotRegex(text, r'location[^{]*/(api|ws)')


if __name__ == '__main__':
    unittest.main()
