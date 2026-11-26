"""Downloads that may only reach the internet: every connection (also each redirect's) goes to an address checked
in the same step, so a name that answers a public address to the check and asus's own to the connection
(DNS rebinding) never reaches a service on asus or the home network.

    opener = public_net.opener(MyRedirectHandler())   # like urllib.request.build_opener, without proxies
    with opener.open(url, timeout=20) as r: ...
"""
import http.client, ipaddress, socket, ssl, urllib.request


def public_socket(host, port, timeout):
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not infos or any(not ipaddress.ip_address(i[4][0].split("%")[0]).is_global for i in infos):
        raise ValueError("that address is not on the internet")
    error = None
    for family, kind, proto, _, addr in infos:  # every address was checked: the next one when one does not answer
        sock = None
        try:
            sock = socket.socket(family, kind, proto)  # may fail too (no IPv6 here): then the next address
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT: sock.settimeout(timeout)
            sock.connect(addr)
            return sock
        except OSError as e:
            if sock: sock.close()
            error = e
    raise error


class _Http(http.client.HTTPConnection):
    def connect(self):
        self.sock = public_socket(self.host, self.port, self.timeout)


class _Https(http.client.HTTPSConnection):
    def connect(self):
        self.sock = self._context.wrap_socket(public_socket(self.host, self.port, self.timeout), server_hostname=self.host)


class _HttpHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_Http, req)


class _HttpsHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_Https, req, context=ssl.create_default_context())


def opener(*handlers):
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _HttpHandler(), _HttpsHandler(), *handlers)
