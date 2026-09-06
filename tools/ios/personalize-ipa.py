"""Add this owner's local Schwab configuration to a compatible unsigned IPA.

This does not build, sign, upload, or execute the app. The output contains the
application credentials and must be kept private. Native build verification is
separate from these archive and configuration checks.
"""

import argparse
import copy
import hashlib
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import struct
import sys
import tempfile
import unicodedata
import zipfile


APP_ROOT = "Payload/THS.app/"
CONFIG_NAME = "SchwabPersonalConfiguration.plist"
CONFIG_PATH = APP_ROOT + CONFIG_NAME
ENV_KEYS = ("SCHWAB_CLIENT_ID", "SCHWAB_CLIENT_SECRET")
MAX_ENTRY_BYTES = 256 * 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MACHO_MAGICS = {
    b"\xcf\xfa\xed\xfe": ("<", 32), b"\xfe\xed\xfa\xcf": (">", 32),
    b"\xce\xfa\xed\xfe": ("<", 28), b"\xfe\xed\xfa\xce": (">", 28),
}
FAT_MAGICS = {b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
              b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"}
METADATA_FIELDS = (
    "filename", "date_time", "compress_type", "comment", "extra", "create_system",
    "create_version", "extract_version", "reserved", "flag_bits", "volume",
    "internal_attr", "external_attr", "CRC", "compress_size", "file_size", "header_offset",
)


class PersonalizationError(Exception):
    """Only constant, non-sensitive messages may be used with this exception."""


def require(condition, message):
    if not condition:
        raise PersonalizationError(message)


def _forbidden_character(value):
    return any(char.isspace() or unicodedata.category(char) in {"Cc", "Cf"}
               for char in value)


def _trim(value):
    # Python additionally considers U+001C...U+001F whitespace. Foundation's
    # whitespace/newline trim does not remove those control characters.
    def whitespace(char):
        return char.isspace() and char not in "\x1c\x1d\x1e\x1f"

    first, last = 0, len(value)
    while first < last and whitespace(value[first]):
        first += 1
    while last > first and whitespace(value[last - 1]):
        last -= 1
    return value[first:last]


def _credential(value, *, client_id):
    value = _trim(value)
    require(1 <= len(value.encode("utf-8")) <= 512 and not _forbidden_character(value),
            "Application credentials have an invalid format.")
    require(not client_id or ":" not in value, "The client identifier has an invalid format.")
    normalized = re.sub(r"[^a-z0-9]", "", value.casefold())
    placeholders = {
        "changeme", "replaceme", "placeholder", "todo", "example", "dummy",
        "yourclientid", "yourclientsecret", "yourclientidhere", "yourclientsecrethere",
        "yourschwabclientid", "yourschwabclientsecret", "yoursecrethere",
        "clientid", "clientsecret", "schwabclientid", "schwabclientsecret",
        "null", "none", "undefined",
    }
    require(normalized not in placeholders and set(value.casefold()) not in ({"x"}, {"*"})
            and not value.startswith(("<", "${", "$(", "{{")),
            "Replace placeholder application credentials before creating a personal IPA.")
    return value


def _env_value(raw):
    raw = _trim(raw)
    if raw.startswith(("'", '"')):
        quote = raw[0]
        end = raw.find(quote, 1)
        require(end != -1, "The local credential file has an invalid quoted value.")
        remainder = _trim(raw[end + 1:])
        require(not remainder or remainder.startswith("#"),
                "The local credential file has an invalid quoted value.")
        return raw[1:end]
    # Only whitespace-prefixed comments are comments; a literal '#' is preserved.
    return _trim(re.split(r"[ \t]+#", raw, maxsplit=1)[0])


def read_configuration(env_file):
    require(env_file.stat().st_size <= 64 * 1024, "The local credential file is too large.")
    text = env_file.read_text(encoding="utf-8-sig")
    values = {}
    for line in text.split("\n"):
        line = _trim(line)
        if not line or line.startswith("#"):
            continue
        if line.startswith("export ") or line.startswith("export\t"):
            line = line[6:].lstrip(" \t")
        key, separator, raw = line.partition("=")
        key = _trim(key)
        if not separator or key not in ENV_KEYS:
            continue
        require(key not in values, "The local credential file has a duplicate application credential.")
        values[key] = _env_value(raw)
    require(set(values) == set(ENV_KEYS), "The local credential file is missing application credentials.")
    return {"schemaVersion": 1,
            "clientID": _credential(values[ENV_KEYS[0]], client_id=True),
            "clientSecret": _credential(values[ENV_KEYS[1]], client_id=False)}


def _path_key(name):
    return unicodedata.normalize("NFC", name.rstrip("/")).casefold()


def _validate_paths(infos):
    require(0 < len(infos) <= 50_000, "The IPA has an unexpected number of ZIP entries.")
    seen = set()
    files = set()
    directories = set()
    apps = set()
    total = 0
    for info in infos:
        name = info.filename
        parts = (name[:-1] if info.is_dir() else name).split("/")
        require(name == info.orig_filename and bool(name) and not name.startswith("/")
                and "\\" not in name and ":" not in name
                and not any(unicodedata.category(char) in {"Cc", "Cf"} for char in name)
                and all(part not in {"", ".", ".."} and not part.endswith((" ", ".")) for part in parts),
                "The IPA contains an unsafe ZIP path.")
        key = _path_key(name)
        require(key not in seen, "The IPA contains duplicate or conflicting ZIP paths.")
        seen.add(key)
        mode = info.external_attr >> 16
        kind = stat.S_IFMT(mode)
        require(kind in {0, stat.S_IFREG, stat.S_IFDIR},
                "The IPA contains a symbolic link or unsupported file type.")
        require(not (kind == stat.S_IFDIR and not info.is_dir())
                and not (kind == stat.S_IFREG and info.is_dir()),
                "The IPA contains inconsistent directory metadata.")
        require(not info.flag_bits & 1, "Encrypted ZIP entries are not supported.")
        require(0 <= info.file_size <= MAX_ENTRY_BYTES, "An IPA entry exceeds the supported size.")
        total += info.file_size
        require(total <= MAX_ARCHIVE_BYTES, "The IPA exceeds the supported expanded size.")
        (directories if info.is_dir() else files).add(key)
        for index in range(1, len(parts)):
            directories.add(_path_key("/".join(parts[:index])))
        for index, part in enumerate(parts):
            if part.casefold().endswith(".app"):
                apps.add("/".join(parts[:index + 1]))
        folded = [part.casefold() for part in parts]
        require("_codesignature" not in folded and folded[-1] not in {"embedded.mobileprovision", "coderesources"},
                "The source IPA contains signing material; use an unsigned archive.")
        require(folded[-1] != CONFIG_NAME.casefold(),
                "The source IPA already contains personal configuration.")
    require(not files.intersection(directories), "The IPA contains a file and directory path conflict.")
    require(apps == {APP_ROOT.rstrip("/")}, "Expected exactly one app at Payload/THS.app.")


def _check_macho(data, *, main_executable=False):
    magic = data[:4]
    require(magic not in FAT_MAGICS, "Universal Mach-O binaries require separate validation.")
    if magic not in MACHO_MAGICS:
        require(not main_executable, "The application executable is not a supported Mach-O binary.")
        return
    endian, header_size = MACHO_MAGICS[magic]
    require(len(data) >= header_size, "The IPA contains a truncated Mach-O header.")
    _, cpu, _, file_type, count, command_bytes = struct.unpack_from(endian + "6I", data)
    end = header_size + command_bytes
    require(end <= len(data), "The IPA contains truncated Mach-O load commands.")
    offset = header_size
    platforms = []
    for _ in range(count):
        require(offset + 8 <= end, "The IPA contains invalid Mach-O load commands.")
        command, size = struct.unpack_from(endian + "2I", data, offset)
        require(size >= 8 and offset + size <= end, "The IPA contains invalid Mach-O load commands.")
        require(command != 0x1D, "The source IPA contains a Mach-O code signature.")
        if command == 0x32:
            require(size >= 24, "The IPA contains an invalid Mach-O platform command.")
            platforms.append(struct.unpack_from(endian + "I", data, offset + 8)[0])
        offset += size
    require(offset == end, "The IPA contains inconsistent Mach-O load commands.")
    require(not platforms or platforms == [2], "The IPA contains a binary for a non-iPhone platform.")
    if main_executable:
        require(magic == b"\xcf\xfa\xed\xfe" and cpu == 0x0100000C and file_type == 2
                and platforms == [2], "Expected an arm64 executable built for physical iOS devices.")


def _entry_digest(archive, info):
    digest = hashlib.sha256()
    with archive.open(info) as item:
        for chunk in iter(lambda: item.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def _file_digest(path, limit=None):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while limit is None or limit > 0:
            chunk = source.read(1024 * 1024 if limit is None else min(limit, 1024 * 1024))
            if not chunk:
                require(limit in (None, 0), "The source IPA changed during processing.")
                break
            digest.update(chunk)
            if limit is not None:
                limit -= len(chunk)
    return digest.digest()


def inspect_source(source):
    with zipfile.ZipFile(source, "r") as archive:
        infos = archive.infolist()
        _validate_paths(infos)
        names = {info.filename for info in infos}
        require(APP_ROOT + "Info.plist" in names, "The IPA is missing its application Info.plist.")
        info = plistlib.loads(archive.read(APP_ROOT + "Info.plist"))
        require(isinstance(info, dict), "The application Info.plist has an invalid format.")
        marker = info.get("THSPersonalConfigurationVersion")
        require(type(marker) is int and marker == 1,
                "This IPA does not support personal configuration; a compatible new build is required.")
        require(info.get("DTPlatformName") == "iphoneos"
                and info.get("CFBundleSupportedPlatforms") == ["iPhoneOS"],
                "The source IPA is not an iPhone device build.")
        executable = info.get("CFBundleExecutable")
        require(isinstance(executable, str) and bool(executable)
                and "/" not in executable and "\\" not in executable
                and executable not in {".", ".."} and APP_ROOT + executable in names,
                "The application executable reference is invalid.")
        main_path = APP_ROOT + executable
        for item in infos:
            if item.is_dir():
                continue
            with archive.open(item) as content:
                magic = content.read(4)
            if item.filename == main_path or magic in MACHO_MAGICS or magic in FAT_MAGICS:
                _check_macho(archive.read(item), main_executable=item.filename == main_path)
        # Reading every entry also checks its decompression and CRC before output is made.
        entries = [(copy.copy(item), _entry_digest(archive, item)) for item in infos]
        return entries, archive.comment, archive.start_dir


def _verify_output(output, entries, comment, prefix_size, prefix_digest, configuration):
    require(_file_digest(output, prefix_size) == prefix_digest,
            "Personalization changed existing compressed archive content.")
    with zipfile.ZipFile(output, "r") as archive:
        infos = archive.infolist()
        require(len(infos) == len(entries) + 1 and infos[-1].filename == CONFIG_PATH
                and archive.comment == comment, "Personal IPA structure verification failed.")
        for item, (original, digest) in zip(infos, entries):
            require(all(getattr(item, field) == getattr(original, field) for field in METADATA_FIELDS)
                    and _entry_digest(archive, item) == digest,
                    "Personalization changed existing archive content or metadata.")
        require(plistlib.loads(archive.read(CONFIG_PATH)) == configuration,
                "Personal configuration verification failed.")


def _publish(temporary, output):
    # Windows rename fails if the destination exists; POSIX link gives the same
    # exclusive, atomic publication without replace()'s overwrite race.
    if os.name == "nt":
        os.rename(temporary, output)
    else:
        os.link(temporary, output)
        temporary.unlink()


def personalize(input_path, output_path, env_file):
    source = Path(input_path).resolve()
    output = Path(output_path).resolve()
    environment = Path(env_file).resolve()
    require(source != output and environment != output, "The output must be a new, separate IPA file.")
    require(not os.path.lexists(output_path) and not os.path.lexists(output),
            "The output already exists; it will not be overwritten.")
    require(source.is_file() and environment.is_file(), "An input file is missing or is not a regular file.")
    require(output.parent.is_dir(), "The output directory does not exist.")
    source_digest = _file_digest(source)
    entries, comment, prefix_size = inspect_source(source)
    configuration = read_configuration(environment)
    payload = plistlib.dumps(configuration, fmt=plistlib.FMT_BINARY, sort_keys=True)
    prefix_digest = _file_digest(source, prefix_size)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".ths-personal-", suffix=".ipa", dir=output.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w+b") as destination, source.open("rb") as original:
            shutil.copyfileobj(original, destination, length=1024 * 1024)
            destination.flush()
            os.fsync(destination.fileno())
        require(_file_digest(temporary) == source_digest, "The source IPA changed during processing.")
        with zipfile.ZipFile(temporary, "a") as archive:
            item = zipfile.ZipInfo(CONFIG_PATH, date_time=(1980, 1, 1, 0, 0, 0))
            item.create_system = 3
            item.external_attr = (stat.S_IFREG | 0o644) << 16
            item.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(item, payload)
        with temporary.open("r+b") as complete:
            os.fsync(complete.fileno())
        _verify_output(temporary, entries, comment, prefix_size, prefix_digest, configuration)
        require(_file_digest(source) == source_digest, "The source IPA changed during processing.")
        _publish(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise PersonalizationError("Invalid arguments; use --help for the required file options.")


def main(argv=None):
    parser = _ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Compatible unsigned iPhone IPA")
    parser.add_argument("--output", required=True, type=Path, help="New private IPA file; must not exist")
    parser.add_argument("--env-file", required=True, type=Path, help="Local file containing only the required application keys or other ignored values")
    try:
        args = parser.parse_args(argv)
        personalize(args.input, args.output, args.env_file)
    except PersonalizationError as error:
        print(f"Unable to prepare personal IPA: {error}", file=sys.stderr)
        return 1
    except Exception:
        # ZIP, plist, Unicode and OS exceptions may contain filenames, file
        # contents or argument values. Never forward them or a traceback.
        print("Unable to prepare personal IPA: a file could not be read, validated, or saved.", file=sys.stderr)
        return 1
    print("Personal IPA prepared and self-verified. The source IPA was not changed. Keep the output private.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
