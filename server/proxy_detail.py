import json
import sys

from mitmproxy.io import FlowReader


def preview(message):
    if message is None:
        return "응답 없음"
    # Present ordinary diagnostic headers without exposing authentication tokens in the UI.
    private = {"authorization", "proxy-authorization", "cookie", "set-cookie"}
    lines = [f"{key}: {'•••' if key.lower() in private else value[:256]}"
             for key, value in list(message.headers.items(multi=True))[:40]]
    body = message.raw_content or b""
    if body:
        mime = message.headers.get("content-type", "").split(";")[0]
        if not message.headers.get("content-encoding") and (
            mime.startswith("text/") or any(kind in mime for kind in ("json", "xml", "urlencoded"))
        ):
            lines.extend(["", body[:4096].decode("utf-8", "replace") + ("…" if len(body) > 4096 else "")])
        else:
            lines.extend(["", f"[{mime or 'binary'} · {len(body)} B]"])
    return "\n".join(lines) or "헤더·본문 없음"


with open(sys.argv[1], "rb") as stream:
    stream.seek(int(sys.argv[2]))
    flow = next(FlowReader(stream).stream())
    print(json.dumps(dict(request=preview(flow.request), response=preview(flow.response))))
