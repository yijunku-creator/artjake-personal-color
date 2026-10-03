#!/usr/bin/env python3
"""아이패드에서 테스트하기 위한 로컬 https 서버.

아이패드 사파리는 https 주소에서만 카메라를 켜준다.
같은 와이파이에 연결된 아이패드에서 https://<맥 IP>:5443 으로 접속한다.
(처음 접속할 때 '연결이 비공개가 아님' 경고가 뜨면 '세부사항 보기 → 이 웹 사이트 방문'을 누른다)
"""
import http.server, os, socket, ssl, subprocess

PORT = 5443
HERE = os.path.dirname(os.path.abspath(__file__))
CERT = os.path.join(HERE, '.cert.pem')
KEY = os.path.join(HERE, '.key.pem')

if not os.path.exists(CERT):
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
                    '-keyout', KEY, '-out', CERT, '-subj', '/CN=artjake-personal-color'],
                   check=True, capture_output=True)

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80)); return s.getsockname()[0]
    except OSError:
        return 'localhost'
    finally:
        s.close()

os.chdir(HERE)
httpd = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), http.server.SimpleHTTPRequestHandler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(CERT, KEY)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print(f'\n  아이패드에서 접속: https://{lan_ip()}:{PORT}\n  (종료: Ctrl+C)\n')
httpd.serve_forever()
