"""Check and capture the isolated RU/EN stand through an ephemeral loopback server."""
import argparse
import base64
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
VARIANTS = ("fabricator", "printer", "fragments")


class Assets(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def source_digest():
    paths = [*ROOT.glob("assets/**/*.js"), *ROOT.glob("assets/**/*.css"), *ROOT.glob("assets/**/*.woff2"), ROOT / "ru/index.html", ROOT / "en/index.html"]
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("posters", "check", "capture"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--lang", choices=("ru", "en"))
    parser.add_argument("--variant", choices=VARIANTS)
    parser.add_argument("--fps", type=int, default=25)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Assets, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = "http://127.0.0.1:" + str(server.server_port)
    checks = []
    digest = source_digest()
    transparent = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1kAAAAASUVORK5CYII=")
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="msedge", headless=True, args=["--no-proxy-server", "--enable-unsafe-swiftshader"])
            for language in (args.lang,) if args.lang else ("ru", "en"):
                for variant in (args.variant,) if args.variant else VARIANTS:
                    widths = (1440, 375) if args.mode == "check" else (1280,)
                    for width in widths:
                        context = browser.new_context(viewport={"width": width, "height": 720 if width > 600 else 900}, device_scale_factor=1)
                        context.add_init_script("crypto.getRandomValues=buffer=>{for(let i=0;i<buffer.length;i++)buffer[i]=123456789;return buffer}")
                        context.add_init_script("window.__inscriptions=[];const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__inscriptions.push(String(text));return original.call(this,text,...args)}")
                        if args.mode == "posters":
                            context.route("**/assets/posters/*.webp", lambda route: route.fulfill(content_type="image/png", body=transparent))
                        page = context.new_page()
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        response = page.goto(origin + "/" + language + "/?scene=" + variant + ("&record=1" if args.mode != "check" else ""), wait_until="load")
                        assert response.status == 200
                        page.evaluate("async () => {await window.demo.ready;window.demo.pause()}")
                        assert page.evaluate("window.demo.prepared"), page.locator("#phase").inner_text()
                        duration = page.evaluate("window.demo.duration")
                        if args.mode == "posters":
                            data = page.evaluate("() => {window.demo.seek(0);return document.querySelector('body>canvas.tg-invite-flight').toDataURL('image/webp',.91)}")
                            path = ROOT / "assets/posters" / (variant + "-" + language + ".webp")
                            path.parent.mkdir(parents=True, exist_ok=True)
                            path.write_bytes(base64.b64decode(data.split(",", 1)[1]))
                            assert path.stat().st_size > 10000
                        elif args.mode == "capture":
                            folder = args.output / (variant + "-" + language)
                            folder.mkdir(exist_ok=True)
                            manifest = folder / "capture.json"
                            metadata = {"source_sha256": digest, "variant": variant, "language": language,
                                        "duration": duration, "fps": args.fps, "width": 1280, "height": 720,
                                        "capture_tool_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
                            if manifest.exists():
                                previous = json.loads(manifest.read_text())
                                assert all(previous[key] == value for key, value in metadata.items()), "Capture inputs changed"
                            metadata["status"] = "running"
                            write_json(manifest, metadata)
                            frames = math.ceil(duration * args.fps) + 1
                            phases = set()
                            for index in range(frames):
                                phase = page.evaluate("""seconds => {
                                  window.demo.seek(seconds);
                                  document.getAnimations().forEach(animation=>{animation.pause();animation.currentTime=seconds*1000;});
                                  return document.querySelector('.tg-invite').dataset.phase;
                                }""", index / args.fps)
                                phases.add(phase)
                                path = folder / ("frame_%05d.jpg" % index)
                                if not path.exists():
                                    temporary = path.with_name(path.name + ".tmp")
                                    temporary.write_bytes(page.screenshot(type="jpeg", quality=90))
                                    temporary.replace(path)
                                if index % 150 == 0:
                                    print(json.dumps({"clip": folder.name, "frame": index, "total": frames}), flush=True)
                            expected = {"build", "hold", "departure", "reset"} | ({"fold"} if variant == "printer" else set())
                            assert phases == expected, phases
                            metadata.update(status="OK", frames=frames, phases=sorted(phases))
                            write_json(manifest, metadata)
                        else:
                            phases = set()
                            for seconds in (0, 3, 5.75 if variant != "fabricator" else 7.15, 8.3, 11, 15, duration - .15):
                                phases.add(page.evaluate("seconds => {window.demo.seek(seconds);return document.querySelector('.tg-invite').dataset.phase}", seconds))
                            assert "build" in phases and "hold" in phases and "departure" in phases and "reset" in phases
                            assert page.locator("body>canvas.tg-invite-flight").evaluate("e=>e.width*e.height<=500000&&getComputedStyle(e).pointerEvents==='none'")
                            assert page.evaluate("document.documentElement.scrollWidth<=innerWidth")
                            captions = page.evaluate("window.__inscriptions")
                            if variant == "printer":
                                assert ("Эксперимент" if language == "ru" else "The experiment") in captions
                                assert ("ЗАМЕТКИ / TELEGRAM" if language == "ru" else "FIELD NOTES / TELEGRAM") in captions
                            if variant == "fabricator":
                                assert ("3D-ПЕЧАТЬ / ЛАБОРАТОРИЯ" if language == "ru" else "ADDITIVE / FIELD LAB") in captions
                            page.screenshot(path=str(args.output / (variant + "-" + language + "-" + str(width) + ".png")))
                            next_variant = VARIANTS[(VARIANTS.index(variant) + 1) % 3]
                            page.locator('[data-scene="' + next_variant + '"]').click()
                            page.evaluate("async()=>await window.demo.ready")
                            assert page.evaluate("window.demo.variant") == next_variant
                            assert page.locator("body>canvas.tg-invite-flight").count() == 1
                        assert not errors, errors
                        checks.append({"language": language, "variant": variant, "width": width, "duration": duration, "status": "OK"})
                        write_json(args.output / "checks.json", {"status": "running", "checks": checks})
                        context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    write_json(args.output / "checks.json", {"status": "OK", "source_sha256": digest, "checks": checks})
    print(json.dumps({"status": "OK", "cases": len(checks), "mode": args.mode}))


if __name__ == "__main__":
    main()
