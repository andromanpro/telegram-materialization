"""Build and verify demonstrations using the installed ffmpeg-skill scripts."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


VARIANTS = ("fabricator", "printer", "fragments")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill-dir", type=Path, required=True)
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--publish-media", type=Path, required=True)
    args = parser.parse_args()
    scripts = args.skill_dir / "scripts"
    args.output.mkdir(parents=True, exist_ok=True)
    args.publish_media.mkdir(parents=True, exist_ok=True)
    inputs = {}
    for language in ("ru", "en"):
        for variant in VARIANTS:
            folder = args.captures / (variant + "-" + language)
            frames = hashlib.sha256()
            for path in sorted(folder.glob("frame_*.jpg")):
                frames.update(path.name.encode())
                frames.update(path.read_bytes())
            inputs[folder.name] = {"capture": digest(folder / "capture.json"), "frames": frames.hexdigest()}
    inputs_hash = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()
    write_json(args.output / "media-inputs.json", inputs)

    def call(tool, params, label):
        command = [sys.executable, str(scripts / (tool + ".py")), *map(str, params)]
        result = subprocess.run(command, capture_output=True, timeout=1800)
        (args.output / (label + ".log")).write_bytes(result.stderr)
        if result.returncode:
            raise RuntimeError(tool + " failed: " + result.stdout.decode(errors="replace") + result.stderr.decode(errors="replace")[-1500:])
        data = json.loads(result.stdout)
        if data.get("output") and Path(data["output"]).is_file():
            data["artifact_sha256"] = digest(Path(data["output"]))
        write_json(args.output / (label + ".json"), data)
        return data

    def render(tool, params, label, output):
        receipt = args.output / (label + ".json")
        request = hashlib.sha256(json.dumps({"tool": tool, "params": list(map(str, params)), "inputs": inputs_hash,
                                            "tool_sha256": digest(scripts / (tool + ".py"))}, sort_keys=True).encode()).hexdigest()
        owned = False
        if receipt.exists() and output.is_file():
            previous = json.loads(receipt.read_text())
            owned = previous.get("verified") and previous.get("artifact_sha256") == digest(output)
            if owned and previous.get("request_sha256") == request:
                return previous
        retry = ["--overwrite"] if owned else []
        plan = call(tool, [*params, *retry, "--dry-run", "--json"], label + "-plan")
        assert plan.get("dry_run") and plan.get("commands"), plan
        result = call(tool, [*params, *retry, "--json"], label)
        assert result.get("verified") and output.stat().st_size > 1000, result
        result["artifact_sha256"] = digest(output)
        result["request_sha256"] = request
        write_json(receipt, result)
        print(json.dumps({"step": label, "status": "verified", "bytes": output.stat().st_size}), flush=True)
        return result

    products = []
    for language in ("ru", "en"):
        clips = []
        for variant in VARIANTS:
            folder = args.captures / (variant + "-" + language)
            metadata = json.loads((folder / "capture.json").read_text())
            assert metadata["status"] == "OK" and metadata["fps"] == 25
            assert len(list(folder.glob("frame_*.jpg"))) == metadata["frames"]
            clip = args.output / (variant + "-" + language + ".mp4")
            result = render("sequence", ["--dir", folder, "--pattern", "frame_%05d.jpg", "--fps", "25", "--preset", "veryfast", "-o", clip], clip.stem + "-sequence", clip)
            probe = result["probe"]
            assert probe["video"]["width"] == 1280 and probe["video"]["height"] == 720
            assert abs(probe["video"]["fps"] - 25) < .01 and not probe.get("audio")
            assert abs(probe["duration"] - metadata["frames"] / 25) < .1
            clips.append(clip)
            gif = args.publish_media / (variant + "-" + language + ".gif")
            result = render("export", [clip, "--preset", "gif", "-o", gif], gif.stem + "-gif", gif)
            probe = result["probe"]
            assert probe["video"]["width"] == 480 and probe["video"]["height"] == 270
            assert abs(probe["duration"] - metadata["frames"] / 25) < .2
            sheet = args.output / (gif.stem + "-sheet.png")
            render("look", [gif, "--tiles", "3x2", "-o", sheet], gif.stem + "-look", sheet)
            products.append({"path": str(gif), "sha256": digest(gif), "probe": probe})
        overview = args.output / ("telegram-materialization-" + language + ".mp4")
        result = render("join", [*clips, "--transition", "none", "--fps", "25", "--width", "1280", "--height", "720", "--fast", "-o", overview], overview.stem + "-join", overview)
        probe = result["probe"]
        assert probe["video"]["codec"] == "h264" and probe["video"]["pix_fmt"] in ("yuv420p", "yuvj420p")
        assert abs(probe["video"]["fps"] - 25) < .01
        assert 79 < probe["duration"] < 81
        call("check", [overview, "--platform", "custom", "--max-duration", "81", "--aspect", "16:9", "--no-loudness", "--json"], overview.stem + "-check")
        sheet = args.output / (overview.stem + "-sheet.png")
        render("look", [overview, "--tiles", "3x2", "-o", sheet], overview.stem + "-look", sheet)
        products.append({"path": str(overview), "sha256": digest(overview), "probe": probe})
    write_json(args.output / "media-verification.json", {"status": "OK", "products": products})
    print(json.dumps({"status": "OK", "gifs": 6, "videos": 2}))


if __name__ == "__main__":
    main()
