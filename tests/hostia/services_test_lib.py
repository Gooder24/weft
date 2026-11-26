"""Loading a service in this process, to reach into it while it answers over HTTP."""
import importlib.util, os, threading
from http.server import ThreadingHTTPServer
from harness import free_port

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def load(name, path, env):
    os.environ.update(env)
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def serve(mod):
    port = free_port()
    srv = ThreadingHTTPServer(("127.0.0.1", port), mod.Api)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return port
