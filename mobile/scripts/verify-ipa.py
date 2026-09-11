"""Validate a standalone Expo iPhone archive without requiring a signing identity."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import plistlib
import struct
import zipfile
import importlib.util

PERSONAL_RESOURCE = "THSPersonalConfiguration.json"


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def check_macho(data):
    require(len(data) >= 32, "Truncated executable")
    magic, cpu, _, kind, count, command_bytes, _, _ = struct.unpack_from("<8I", data)
    require((magic, cpu, kind) == (0xFEEDFACF, 0x0100000C, 2), "Expected arm64 Mach-O executable")
    end = 32 + command_bytes
    require(end <= len(data), "Truncated Mach-O load commands")
    offset, platforms = 32, []
    for _ in range(count):
        require(offset + 8 <= end, "Missing Mach-O load command")
        command, size = struct.unpack_from("<2I", data, offset)
        require(size >= 8 and offset + size <= end, "Invalid Mach-O command")
        if command == 0x32:
            require(size >= 24, "Invalid build version command")
            platforms.append(struct.unpack_from("<I", data, offset + 8)[0])
        offset += size
    require(offset == end and platforms == [2], "Expected physical iOS device platform")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ipa", type=Path)
    parser.add_argument("--bundle-id", default="app.personal.ths.expo")
    parser.add_argument("--version", default="0.6.3")
    parser.add_argument("--allow-personal-config", action="store_true")
    args = parser.parse_args()
    with zipfile.ZipFile(args.ipa) as archive:
        require(archive.testzip() is None, "ZIP integrity failed")
        names = archive.namelist()
        personal_files = [name for name in names if PurePosixPath(name).name == PERSONAL_RESOURCE]
        require(not personal_files or args.allow_personal_config, "Personal configuration in archive")
        require(len(names) == len(set(names)), "Duplicate archive paths")
        for name in names:
            path = PurePosixPath(name)
            require(not path.is_absolute() and ".." not in path.parts and "\\" not in name,
                    "Unsafe archive path")
            require(not any(part.lower().startswith(".env") for part in path.parts), "Environment file in archive")
            require("personal-config" not in name.lower() and "SchwabPersonalConfiguration.plist" not in name,
                    "Personal configuration in archive")
            require(path.suffix.lower() not in {".p12", ".p8", ".pem", ".key", ".mobileprovision"},
                    "Signing credentials in archive")
        plists = [name for name in names if name.startswith("Payload/") and name.endswith(".app/Info.plist") and name.count("/") == 2]
        require(len(plists) == 1, "Expected exactly one app")
        info = plistlib.loads(archive.read(plists[0]))
        root = plists[0].removesuffix("Info.plist")
        if args.allow_personal_config:
            require(personal_files == [root + PERSONAL_RESOURCE], "Expected one root personal configuration")
            require(archive.getinfo(personal_files[0]).file_size <= 16384, "Personal configuration is too large")
            spec = importlib.util.spec_from_file_location("ipa_personalizer", Path(__file__).with_name("personalize-ipa.py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            try:
                module.validate_config(archive.read(personal_files[0]))
            except (ValueError, UnicodeError):
                raise SystemExit("Invalid personal configuration") from None
        require(info.get("CFBundleIdentifier") == args.bundle_id, "Bundle identifier mismatch")
        require(info.get("CFBundleShortVersionString") == args.version, "Version mismatch")
        require(info.get("DTPlatformName") == "iphoneos" and info.get("CFBundleSupportedPlatforms") == ["iPhoneOS"],
                "Not a physical iPhone build")
        check_macho(archive.read(root + info["CFBundleExecutable"]))
        bundle = archive.read(root + "main.jsbundle")
        require(len(bundle) > 10000, "Missing standalone JavaScript bundle")
        # Hermes bytecode magic used by the production Expo export.
        require(bundle[:8] == bytes.fromhex("c61fbc03c103191f"), "Expected production Hermes bytecode")
    print(json.dumps({"version": args.version, "build": info.get("CFBundleVersion"),
                      "bundle_id": args.bundle_id, "platform": "iphoneos", "architecture": "arm64",
                      "minimum_ios": info.get("MinimumOSVersion"), "embedded_hermes_bytes": len(bundle),
                      "bytes": args.ipa.stat().st_size, "sha256": hashlib.sha256(args.ipa.read_bytes()).hexdigest(),
                      "personal_config": "present" if personal_files else "absent", "requires_user_signing": True,
                      "physical_iphone_tested": False}, indent=2))


if __name__ == "__main__":
    main()
