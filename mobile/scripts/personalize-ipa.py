"""Inject user-authorized app credentials locally, after the cloud build and before signing."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import unicodedata
import zipfile

RESOURCE = "THSPersonalConfiguration.json"


def validate_config(raw):
    if len(raw) > 16384:
        raise ValueError("Configuration is too large")
    try:
        config = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ValueError("Invalid configuration JSON") from None
    if not isinstance(config, dict) or set(config) != {"version", "clientID", "clientSecret"} or type(config["version"]) is not int or config["version"] != 1:
        raise ValueError("Unsupported configuration schema")
    for name in ("clientID", "clientSecret"):
        value = config[name]
        if not isinstance(value, str):
            raise ValueError("Invalid application credentials")
        value = value.strip()
        if not value or len(value.encode("utf-8")) > 512 or any(c.isspace() or unicodedata.category(c) in {"Cc", "Cf"} for c in value):
            raise ValueError("Invalid application credentials")
        config[name] = value
    if ":" in config["clientID"]:
        raise ValueError("Invalid client identifier")
    return config


def personalize(source, config_file, output):
    source, config_file, output = map(Path, (source, config_file, output))
    if output.resolve() in {source.resolve(), config_file.resolve()} or output.exists():
        raise ValueError("Output must be a new file distinct from inputs")
    with config_file.open("rb") as handle:
        config = validate_config(handle.read(16385))
    with zipfile.ZipFile(source) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or archive.testzip() is not None:
            raise ValueError("Invalid archive integrity")
        for name in names:
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or "\\" in name:
                raise ValueError("Unsafe archive path")
            if path.name == RESOURCE or "personal-config" in name.lower() or "SchwabPersonalConfiguration.plist" in name:
                raise ValueError("Source already contains personal configuration")
            if path.suffix.lower() in {".p12", ".p8", ".pem", ".key", ".mobileprovision"} or "_CodeSignature" in path.parts:
                raise ValueError("Use the original unsigned archive")
        plists = [n for n in names if n.startswith("Payload/") and n.endswith(".app/Info.plist") and n.count("/") == 2]
        if len(plists) != 1:
            raise ValueError("Expected one application bundle")
        resource_path = plists[0].removesuffix("Info.plist") + RESOURCE
        created = False
        try:
            with output.open("xb") as target:
                created = True
                with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as result:
                    for entry in archive.infolist():
                        result.writestr(entry, archive.read(entry.filename))
                    result.writestr(resource_path, json.dumps(config, ensure_ascii=True, separators=(",", ":")))
        except BaseException:
            if created:
                output.unlink(missing_ok=True)
            raise
    return {"personal_config": "present", "requires_user_signing": True,
            "bytes": output.stat().st_size, "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = personalize(args.source, args.config, args.output)
    except (ValueError, OSError, zipfile.BadZipFile):
        parser.exit(1, "Personalization failed: check unsigned archive, configuration schema and new output path.\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
