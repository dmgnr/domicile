#!/usr/bin/env python3
"""A notification server and the page that guard-notification-window.sh and
guard-notification-site-icon.sh load.

Two jobs, so each guard starts one helper:

- Takes org.freedesktop.Notifications on the session bus and answers what
  Chrome's notification bridge asks: GetCapabilities, GetServerInformation and
  Notify. For each Notify it prints two lines:
    `NOTIFY <summary> <hints>`, hints as JSON;
    `ICON <summary> <color>`, the color at the center of its application
    icon's file: `red`, `other`, or `none` when it names no PNG file.
  Speaks the D-Bus wire protocol itself, because the guards' shell has no
  D-Bus module for Python.
- Serves `/notify`, a page that shows a notification named by its `?summary=`
  once it is allowed to: again every half second, `?times=` times in all (1
  when absent). With `?favicon=red` the page's favicon is `/favicon.png`,
  solid red; otherwise the site has no favicon.

The guards seed the profile so the page's origin may notify.
"""

import argparse
import json
import os
import socket
import struct
import sys
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

NAME = "org.freedesktop.Notifications"
PATH = "/org/freedesktop/Notifications"

# What Chrome's bridge needs to use this server: `body` and `actions`, else it
# falls back to the portal.
CAPABILITIES = ["actions", "body", "persistence"]

PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>a page that notifies</title>
    {favicon}
  </head>
  <body>
    <script>
      let left = {times};
      const notify = () => {{
        new Notification({summary});
        console.log("GUARD notified");
        left -= 1;
        if (left > 0) {{
          setTimeout(notify, 500);
        }}
      }};
      notify();
    </script>
  </body>
</html>
"""

# The side of the red favicon, in pixels: a site's usual favicon size.
FAVICON_SIDE = 16

# Message types and header fields of the D-Bus wire protocol.
METHOD_CALL, METHOD_RETURN, ERROR, SIGNAL = 1, 2, 3, 4
PATH_FIELD, INTERFACE_FIELD, MEMBER_FIELD = 1, 2, 3
REPLY_SERIAL_FIELD, DESTINATION_FIELD, SIGNATURE_FIELD = 5, 6, 8


def pad(offset, alignment):
    return (alignment - offset % alignment) % alignment


class Writer:
    """Marshals values little-endian, aligned from the message's start."""

    def __init__(self):
        self.data = bytearray()

    def align(self, alignment):
        self.data += b"\0" * pad(len(self.data), alignment)

    def byte(self, value):
        self.data += struct.pack("<B", value)

    def uint32(self, value):
        self.align(4)
        self.data += struct.pack("<I", value)

    def string(self, value):
        encoded = value.encode()
        self.uint32(len(encoded))
        self.data += encoded + b"\0"

    def signature(self, value):
        encoded = value.encode()
        self.byte(len(encoded))
        self.data += encoded + b"\0"

    def strings(self, values):
        self.uint32(0)
        length_at = len(self.data) - 4
        self.align(4)
        start = len(self.data)
        for value in values:
            self.string(value)
        struct.pack_into("<I", self.data, length_at, len(self.data) - start)


class Reader:
    """Unmarshals the values Notify carries, aligned from the body's start."""

    def __init__(self, data):
        self.data = data
        self.at = 0

    def align(self, alignment):
        self.at += pad(self.at, alignment)

    def take(self, code):
        if code in "y":
            value = self.data[self.at]
            self.at += 1
            return value
        if code in "bui":
            self.align(4)
            (value,) = struct.unpack_from("<i" if code == "i" else "<I", self.data, self.at)
            self.at += 4
            return bool(value) if code == "b" else value
        if code in "so":
            self.align(4)
            (length,) = struct.unpack_from("<I", self.data, self.at)
            self.at += 4
            value = self.data[self.at : self.at + length].decode()
            self.at += length + 1
            return value
        if code == "g":
            length = self.data[self.at]
            value = self.data[self.at + 1 : self.at + 1 + length].decode()
            self.at += length + 2
            return value
        raise ValueError(f"cannot read {code}")

    def skip_array(self, element_alignment):
        self.align(4)
        (length,) = struct.unpack_from("<I", self.data, self.at)
        self.at += 4
        self.align(element_alignment)
        self.at += length

    def strings(self):
        self.align(4)
        (length,) = struct.unpack_from("<I", self.data, self.at)
        self.at += 4
        end = self.at + length
        values = []
        while self.at < end:
            values.append(self.take("s"))
        return values

    def hints(self):
        """An a{sv}, keeping the string-valued and integer-valued hints."""
        self.align(4)
        (length,) = struct.unpack_from("<I", self.data, self.at)
        self.at += 4
        self.align(8)
        end = self.at + length
        hints = {}
        while self.at < end:
            self.align(8)
            key = self.take("s")
            signature = self.take("g")
            if signature in ("s", "u", "i", "b", "y"):
                hints[key] = self.take(signature)
            elif signature == "(iiibiiay)":
                # image-data: a picture this guard does not read.
                self.align(8)
                for code in "iiibii":
                    self.take(code)
                self.skip_array(1)
                hints[key] = "<image>"
            else:
                raise ValueError(f"hint {key} has signature {signature}")
        return hints


class Bus:
    """One connection to the session bus."""

    def __init__(self, address):
        path = address.split("unix:path=", 1)[1].split(",", 1)[0]
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.serial = 0
        self.buffer = b""
        uid = str(os.getuid()).encode().hex()
        self.sock.sendall(b"\0AUTH EXTERNAL " + uid.encode() + b"\r\n")
        if not self.line().startswith(b"OK"):
            raise RuntimeError("the bus refused EXTERNAL")
        self.sock.sendall(b"BEGIN\r\n")

    def line(self):
        while b"\r\n" not in self.buffer:
            self.buffer += self.sock.recv(4096)
        line, self.buffer = self.buffer.split(b"\r\n", 1)
        return line

    def send(self, kind, fields, signature="", body=b"", flags=0):
        self.serial += 1
        if signature:
            fields = fields + [(SIGNATURE_FIELD, "g", signature)]
        header = Writer()
        header.data += b"l" + bytes([kind, flags, 1])
        header.uint32(len(body))
        header.uint32(self.serial)
        header.uint32(0)
        array_start = len(header.data)
        for code, kind_of, value in fields:
            header.align(8)
            header.byte(code)
            header.signature(kind_of)
            {"o": header.string, "s": header.string, "u": header.uint32, "g": header.signature}[kind_of](value)
        struct.pack_into("<I", header.data, array_start - 4, len(header.data) - array_start)
        header.align(8)
        self.sock.sendall(bytes(header.data) + body)
        return self.serial

    def call_bus(self, member, signature="", body=b""):
        self.send(
            METHOD_CALL,
            [
                (PATH_FIELD, "o", "/org/freedesktop/DBus"),
                (INTERFACE_FIELD, "s", "org.freedesktop.DBus"),
                (MEMBER_FIELD, "s", member),
                (DESTINATION_FIELD, "s", "org.freedesktop.DBus"),
            ],
            signature,
            body,
        )

    def reply(self, call, signature, body):
        fields = [(REPLY_SERIAL_FIELD, "u", call["serial"])]
        if "sender" in call:
            fields.append((DESTINATION_FIELD, "s", call["sender"]))
        self.send(METHOD_RETURN, fields, signature, body)

    def receive(self):
        """The next message: its kind, serial, header fields and body."""
        while len(self.buffer) < 16:
            self.buffer += self.sock.recv(65536)
        body_length, serial, fields_length = struct.unpack_from("<III", self.buffer, 4)
        header_length = 16 + fields_length + pad(16 + fields_length, 8)
        while len(self.buffer) < header_length + body_length:
            self.buffer += self.sock.recv(65536)
        message = {"kind": self.buffer[1], "serial": serial}
        fields = Reader(self.buffer[16 : 16 + fields_length])
        names = {1: "path", 2: "interface", 3: "member", 6: "destination", 7: "sender", 8: "signature"}
        while fields.at < fields_length:
            fields.align(8)
            code = fields.take("y")
            kind = fields.take("g")
            value = fields.take(kind)
            if code in names:
                message[names[code]] = value
        message["body"] = self.buffer[header_length : header_length + body_length]
        self.buffer = self.buffer[header_length + body_length :]
        return message


def png(width, height, rgba):
    """An 8-bit RGBA PNG of `width` by `height` pixels all `rgba`."""

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    rows = b"".join(b"\0" + bytes(rgba) * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def center_of(data):
    """The (r, g, b) at the center of 8-bit, non-interlaced PNG `data`."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    at = 8
    idat = b""
    while at < len(data):
        (length,) = struct.unpack_from(">I", data, at)
        kind = data[at + 4 : at + 8]
        body = data[at + 8 : at + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat += body
        at += 12 + length
    channels = {2: 3, 6: 4}.get(color)
    if depth != 8 or channels is None or interlace != 0:
        raise ValueError(f"cannot read a PNG of depth {depth}, color {color}, interlace {interlace}")
    raw = zlib.decompress(idat)
    stride = width * channels
    previous = bytearray(stride)
    middle = height // 2
    for y in range(middle + 1):
        start = y * (stride + 1)
        kind = raw[start]
        row = bytearray(raw[start + 1 : start + 1 + stride])
        for x in range(stride):
            left = row[x - channels] if x >= channels else 0
            up = previous[x]
            corner = previous[x - channels] if x >= channels else 0
            if kind == 1:
                row[x] = (row[x] + left) & 0xFF
            elif kind == 2:
                row[x] = (row[x] + up) & 0xFF
            elif kind == 3:
                row[x] = (row[x] + (left + up) // 2) & 0xFF
            elif kind == 4:
                guess = left + up - corner
                near = min(
                    (abs(guess - left), left),
                    (abs(guess - up), up),
                    (abs(guess - corner), corner),
                    key=lambda pair: pair[0],
                )[1]
                row[x] = (row[x] + near) & 0xFF
        previous = row
    pixel = previous[(width // 2) * channels :][:3]
    return tuple(pixel)


def color_of(app_icon):
    """`red`, `other` or `none`: the center of the PNG file `app_icon` names."""
    path = app_icon.removeprefix("file://")
    if not path.startswith("/"):
        return "none"
    try:
        with open(path, "rb") as file:
            red, green, blue = center_of(file.read())
    except (OSError, ValueError):
        return "none"
    return "red" if red > 200 and green < 60 and blue < 60 else "other"


def serve_notifications(address):
    bus = Bus(address)
    bus.call_bus("Hello")
    name = Writer()
    name.string(NAME)
    name.uint32(4)  # DBUS_NAME_FLAG_DO_NOT_QUEUE
    bus.call_bus("RequestName", "su", bytes(name.data))
    print(f"took {NAME}", flush=True)
    next_id = 1
    while True:
        message = bus.receive()
        if message["kind"] != METHOD_CALL or message.get("interface") != NAME:
            continue
        member = message.get("member")
        if member == "GetCapabilities":
            body = Writer()
            body.strings(CAPABILITIES)
            bus.reply(message, "as", bytes(body.data))
        elif member == "GetServerInformation":
            body = Writer()
            for value in ("guard", "domicile", "1", "1.2"):
                body.string(value)
            bus.reply(message, "ssss", bytes(body.data))
        elif member == "Notify":
            read = Reader(message["body"])
            read.take("s")
            read.take("u")
            app_icon = read.take("s")
            summary = read.take("s")
            read.take("s")
            read.strings()
            hints = read.hints()
            print(f"NOTIFY {summary} {json.dumps(hints, sort_keys=True)}", flush=True)
            print(f"ICON {summary} {color_of(app_icon)}", flush=True)
            body = Writer()
            body.uint32(next_id)
            next_id += 1
            bus.reply(message, "u", bytes(body.data))


def handler_for():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            url = urlsplit(self.path)
            if url.path == "/favicon.png":
                self.send(png(FAVICON_SIDE, FAVICON_SIDE, (255, 0, 0, 255)), "image/png")
                return
            if url.path != "/notify":
                self.send_error(404)
                return
            query = parse_qs(url.query)
            summary = query.get("summary", ["guard"])[0]
            times = int(query.get("times", ["1"])[0])
            favicon = (
                '<link rel="icon" href="/favicon.png" />'
                if query.get("favicon", [""])[0] == "red"
                else ""
            )
            page = PAGE.format(summary=json.dumps(summary), times=times, favicon=favicon)
            self.send(page.encode(), "text/html; charset=utf-8")

        def send(self, body, content_type):
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    address = os.environ.get("DBUS_SESSION_BUS_ADDRESS", "")
    if "unix:path=" not in address:
        print("DBUS_SESSION_BUS_ADDRESS names no unix:path= bus", file=sys.stderr)
        return 1
    threading.Thread(target=serve_notifications, args=(address,), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for())
    print(f"serving the page on 127.0.0.1:{server.server_address[1]}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
