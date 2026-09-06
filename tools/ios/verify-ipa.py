"""Check archive integrity and confirm an unsigned, device-only arm64 iOS build."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import struct
import zipfile


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ipa", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--build", required=True)
    parser.add_argument("--bundle-id", default="app.personal.ths")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    with zipfile.ZipFile(args.ipa) as archive:
        require(archive.testzip() is None, "ZIP integrity check failed")
        names = archive.namelist()
        plists = [name for name in names if name.startswith("Payload/") and name.endswith(".app/Info.plist") and name.count("/") == 2]
        require(len(plists) == 1, "Expected exactly one application")
        plist_path = plists[0]
        info = plistlib.loads(archive.read(plist_path))
        root = plist_path.removesuffix("Info.plist")
        require(info["CFBundleIdentifier"] == args.bundle_id, "Bundle identifier mismatch")
        require(info["CFBundleShortVersionString"] == args.version, "Version mismatch")
        require(info["CFBundleVersion"] == args.build, "Build number mismatch")
        require(info.get("DTPlatformName") == "iphoneos", "Archive is not an iPhone device build")
        require(info.get("CFBundleSupportedPlatforms") == ["iPhoneOS"], "Unexpected supported platform")
        require(not any("/_CodeSignature/" in name or name.endswith("/embedded.mobileprovision") for name in names), "Archive contains signing material")
        executable = archive.read(root + info["CFBundleExecutable"])
        require(len(executable) >= 32, "Truncated executable")
        magic, cpu, _, file_type, count, command_bytes, _, _ = struct.unpack_from("<8I", executable)
        require(magic == 0xFEEDFACF and cpu == 0x0100000C and file_type == 2, "Expected an arm64 Mach-O executable")
        require(32 + command_bytes <= len(executable), "Truncated Mach-O commands")
        offset = 32
        platforms = []
        for _ in range(count):
            command, size = struct.unpack_from("<2I", executable, offset)
            require(size >= 8 and offset + size <= 32 + command_bytes, "Invalid Mach-O command")
            require(command != 0x1D, "Executable has a code signature")
            if command == 0x32:
                require(size >= 24, "Invalid build version command")
                platforms.append(struct.unpack_from("<I", executable, offset + 8)[0])
            offset += size
        require(offset == 32 + command_bytes, "Mach-O command size mismatch")
        require(platforms == [2], "Executable was not built for physical iOS devices")
        require(b"--uitesting-demo" not in executable and b"--snapshot-tab" not in executable, "Release contains UI test launch switches")
    result = dict(app=info["CFBundleName"], version=args.version, build=args.build,
                  bundle_id=args.bundle_id, minimum_ios=info.get("MinimumOSVersion"), sdk=info.get("DTSDKName"),
                  architecture="arm64", signing="unsigned", bytes=args.ipa.stat().st_size,
                  sha256=hashlib.sha256(args.ipa.read_bytes()).hexdigest(),
                  zip_integrity="passed", device_platform="iOS", debug_test_switches_present=False,
                  physical_iphone_tested=False)
    rendered = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
