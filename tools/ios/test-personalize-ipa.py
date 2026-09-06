"""Offline tests using fabricated credentials and deliberately synthetic IPA files."""

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import plistlib
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile


SPEC = importlib.util.spec_from_file_location("personalize_ipa", Path(__file__).with_name("personalize-ipa.py"))
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)
FAKE_ID = "fixture-personal-client-123"
FAKE_SECRET = "fixture-personal-secret-456"


def synthetic_macho(*, platform=2, signed=False):
    """A parseable command table, not an executable or native build assertion."""
    commands = struct.pack("<6I", 0x32, 24, platform, 0x110000, 0x1A0500, 0)
    if signed:
        commands += struct.pack("<4I", 0x1D, 16, 0, 0)
    return struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 2,
                       2 if signed else 1, len(commands), 0, 0) + commands + b"synthetic-fixture"


class PersonalizeIPATests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="ths-personal-tests-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source.ipa"
        self.output = self.root / "personal.ipa"
        self.env = self.root / "local.env"
        self.write_env()
        self.write_ipa()

    def write_env(self, value=None):
        self.env.write_text(value if value is not None else (
            f"SCHWAB_CLIENT_ID={FAKE_ID}\nSCHWAB_CLIENT_SECRET={FAKE_SECRET}\n"
            "SCHWAB_ACCESS_TOKEN=fixture-token-never-import\n"
            "ACCOUNT_NUMBER=fixture-account-never-import\n"
        ), encoding="utf-8")

    def write_ipa(self, *, info_changes=None, omit_marker=False, executable=None, extra=()):
        info = {"CFBundleName": "THS", "CFBundleIdentifier": "app.personal.ths",
                "CFBundleExecutable": "THS", "CFBundlePackageType": "APPL",
                "DTPlatformName": "iphoneos", "CFBundleSupportedPlatforms": ["iPhoneOS"],
                "THSPersonalConfigurationVersion": 1}
        if omit_marker:
            del info["THSPersonalConfigurationVersion"]
        info.update(info_changes or {})
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.source, "w") as archive:
                archive.comment = b"fixture-archive-comment"
                for name in ("Payload/", TOOL.APP_ROOT):
                    directory = zipfile.ZipInfo(name, date_time=(2026, 1, 2, 3, 4, 6))
                    directory.create_system = 3
                    directory.external_attr = (stat.S_IFDIR | 0o755) << 16
                    archive.writestr(directory, b"")
                archive.writestr(TOOL.APP_ROOT + "Info.plist", plistlib.dumps(info))
                binary = zipfile.ZipInfo(TOOL.APP_ROOT + "THS", date_time=(2026, 1, 2, 3, 4, 6))
                binary.create_system = 3
                binary.external_attr = (stat.S_IFREG | 0o755) << 16
                binary.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(binary, executable if executable is not None else synthetic_macho())
                resource = zipfile.ZipInfo(TOOL.APP_ROOT + "fixture-resource.txt", date_time=(2026, 2, 3, 4, 5, 6))
                resource.create_system = 3
                resource.external_attr = (stat.S_IFREG | 0o640) << 16
                resource.comment = b"fixture-entry-comment"
                resource.extra = struct.pack("<HH4s", 0xCAFE, 4, b"test")
                resource.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(resource, b"Existing resource contents must remain exactly unchanged.\n")
                for name, data in extra:
                    archive.writestr(name, data)

    def run_cli(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = TOOL.main(list(args) if args else [
                "--input", str(self.source), "--output", str(self.output), "--env-file", str(self.env)
            ])
        return result, stdout.getvalue(), stderr.getvalue()

    def assert_rejected(self, *, message=None):
        original = self.source.read_bytes()
        result, stdout, stderr = self.run_cli()
        self.assertEqual(result, 1)
        self.assertEqual(stdout, "")
        if message:
            self.assertIn(message, stderr)
        for private in (FAKE_ID, FAKE_SECRET, "fixture-token-never-import", "fixture-account-never-import"):
            self.assertNotIn(private, stdout + stderr)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob(".ths-personal-*")), [])
        return stderr

    def test_success_adds_only_two_credentials_and_preserves_source_contents_and_metadata(self):
        before = self.source.read_bytes()
        with zipfile.ZipFile(self.source) as archive:
            prefix_size = archive.start_dir
            snapshot = [(item, archive.read(item)) for item in archive.infolist()]
        result, stdout, stderr = self.run_cli()
        self.assertEqual((result, stderr), (0, ""))
        self.assertIn("self-verified", stdout)
        self.assertNotIn(FAKE_ID, stdout)
        self.assertNotIn(FAKE_SECRET, stdout)
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(self.output.read_bytes()[:prefix_size], before[:prefix_size])
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(archive.comment, b"fixture-archive-comment")
            self.assertEqual(len(archive.infolist()), len(snapshot) + 1)
            for previous, contents in snapshot:
                current = archive.getinfo(previous.filename)
                for field in TOOL.METADATA_FIELDS:
                    self.assertEqual(getattr(current, field), getattr(previous, field), field)
                self.assertEqual(archive.read(current), contents)
            configuration = plistlib.loads(archive.read(TOOL.CONFIG_PATH))
            self.assertEqual(configuration, {"schemaVersion": 1, "clientID": FAKE_ID, "clientSecret": FAKE_SECRET})
            self.assertIs(type(configuration["schemaVersion"]), int)
            self.assertEqual(archive.testzip(), None)

    def test_environment_supports_bom_literal_quotes_export_and_comments_without_expansion(self):
        self.write_env("\ufeff# ignored\nexport SCHWAB_CLIENT_ID = ' " + FAKE_ID + " ' # comment\n"
                       + 'SCHWAB_CLIENT_SECRET="literal:secret#value\\n"\n'
                       + "UNRELATED='unterminated and ignored\n")
        configuration = TOOL.read_configuration(self.env)
        self.assertEqual(configuration["clientID"], FAKE_ID)
        self.assertEqual(configuration["clientSecret"], "literal:secret#value\\n")

    def test_missing_duplicate_and_malformed_values_are_rejected(self):
        cases = [
            f"SCHWAB_CLIENT_ID={FAKE_ID}\n",
            f"SCHWAB_CLIENT_ID={FAKE_ID}\nSCHWAB_CLIENT_ID={FAKE_ID}\nSCHWAB_CLIENT_SECRET={FAKE_SECRET}\n",
            f"SCHWAB_CLIENT_ID={FAKE_ID}\nSCHWAB_CLIENT_SECRET='unterminated-{FAKE_SECRET}\n",
            f'SCHWAB_CLIENT_ID={FAKE_ID}\nSCHWAB_CLIENT_SECRET="{FAKE_SECRET}" unexpected\n',
        ]
        for value in cases:
            with self.subTest(value=value):
                self.write_env(value)
                self.assert_rejected()

    def test_empty_placeholders_whitespace_controls_and_identifier_colon_are_rejected(self):
        cases = ["", "YOUR_CLIENT_ID", "your-client-secret-here", "change_me", "xxxx", "***",
                 "<insert-value>", "${SECRET_FROM_ELSEWHERE}", "$(external-command)",
                 "space inside", "tab\tinside", "control\x00inside", "format\u200binside",
                 "control-at-end\x1c", "\x1dcontrol-at-start",
                 "line\u2028inside", "a" * 513, "é" * 257]
        for value in cases:
            with self.subTest(value=value):
                self.write_env(f"SCHWAB_CLIENT_ID={FAKE_ID}\nSCHWAB_CLIENT_SECRET={value}\n")
                self.assert_rejected()
        self.write_env(f"SCHWAB_CLIENT_ID=id:colon\nSCHWAB_CLIENT_SECRET={FAKE_SECRET}\n")
        self.assert_rejected()

    def test_swift_credential_byte_bounds_and_secret_colon_are_preserved(self):
        self.write_env("SCHWAB_CLIENT_ID=a\nSCHWAB_CLIENT_SECRET=" + "é" * 255 + ":z\n")
        configuration = TOOL.read_configuration(self.env)
        self.assertEqual(configuration["clientID"], "a")
        self.assertEqual(len(configuration["clientSecret"].encode("utf-8")), 512)

    def test_errors_never_echo_credential_values_full_lines_or_underlying_exceptions(self):
        sensitive = "fixture-private-value-with-secret-characters"
        line = f"SCHWAB_CLIENT_SECRET={sensitive} internal whitespace"
        self.write_env(f"SCHWAB_CLIENT_ID={FAKE_ID}\n{line}\n")
        stderr = self.assert_rejected()
        self.assertNotIn(sensitive, stderr)
        self.assertNotIn(line, stderr)
        self.write_env()
        with patch.object(TOOL, "read_configuration", side_effect=OSError(sensitive)):
            stderr = self.assert_rejected()
        self.assertNotIn(sensitive, stderr)

    def test_old_or_wrong_version_markers_are_rejected(self):
        self.write_ipa(omit_marker=True)
        self.assert_rejected(message="compatible new build")
        for marker in (0, 2, "1", True, None):
            with self.subTest(marker=marker):
                self.write_ipa(info_changes={"THSPersonalConfigurationVersion": marker if marker is not None else b"invalid"})
                self.assert_rejected(message="compatible new build")

    def test_simulator_plists_and_simulator_macho_are_rejected(self):
        for changes in ({"DTPlatformName": "iphonesimulator"},
                        {"CFBundleSupportedPlatforms": ["iPhoneSimulator"]},
                        {"CFBundleSupportedPlatforms": ["iPhoneOS", "iPhoneSimulator"]}):
            with self.subTest(changes=changes):
                self.write_ipa(info_changes=changes)
                self.assert_rejected(message="iPhone device build")
        self.write_ipa(executable=synthetic_macho(platform=7))
        self.assert_rejected(message="non-iPhone platform")

    def test_signature_files_and_embedded_macho_signatures_are_rejected(self):
        for name in (TOOL.APP_ROOT + "_CodeSignature/CodeResources", TOOL.APP_ROOT + "embedded.mobileprovision",
                     TOOL.APP_ROOT + "_codesignature/other", TOOL.APP_ROOT + "CodeResources"):
            with self.subTest(name=name):
                self.write_ipa(extra=[(name, b"fixture-signing-content")])
                self.assert_rejected(message="signing material")
        self.write_ipa(executable=synthetic_macho(signed=True))
        self.assert_rejected(message="Mach-O code signature")
        self.write_ipa(extra=[(TOOL.APP_ROOT + "Frameworks/Fixture.framework/Fixture", synthetic_macho(signed=True))])
        self.assert_rejected(message="Mach-O code signature")

    def test_malformed_main_executable_and_macho_commands_are_rejected(self):
        for binary in (b"not-a-Mach-O", b"\xcf\xfa\xed\xfe", synthetic_macho()[:40],
                       struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 2, 2, 0, 0, 0),
                       b"\xca\xfe\xba\xbe" + b"unvalidated-fat-binary"):
            with self.subTest(binary=binary):
                self.write_ipa(executable=binary)
                self.assert_rejected()
        self.write_ipa(info_changes={"CFBundleExecutable": "../elsewhere"})
        self.assert_rejected(message="executable reference")

    def test_multiple_apps_and_existing_personal_resource_are_rejected(self):
        for extra in (
            [("Payload/Second.app/Info.plist", b"fixture")],
            [(TOOL.APP_ROOT + "Watch/Nested.app/Info.plist", b"fixture")],
            [(TOOL.CONFIG_PATH, b"fixture-existing-configuration")],
            [(TOOL.APP_ROOT + CONFIG_LOWER, b"fixture-existing-configuration")]
        ):
            with self.subTest(extra=extra):
                self.write_ipa(extra=extra)
                self.assert_rejected()

    def test_unsafe_duplicate_normalized_and_file_directory_paths_are_rejected(self):
        for path in ("../outside", "/absolute", "C:/drive", "Payload/../outside", "Payload//double",
                     TOOL.APP_ROOT + "double//", TOOL.APP_ROOT + "trailing-space ", TOOL.APP_ROOT + "trailing-dot.",
                     "Payload/./dot", TOOL.APP_ROOT + "control\x01name",
                     TOOL.APP_ROOT + "format\u200bname"):
            with self.subTest(path=path):
                self.write_ipa(extra=[(path, b"fixture")])
                self.assert_rejected(message="unsafe ZIP path")
        for extra in (
            [(TOOL.APP_ROOT + "Info.plist", b"fixture-duplicate")],
            [(TOOL.APP_ROOT + "INFO.PLIST", b"fixture-case-collision")],
            [(TOOL.APP_ROOT + "é.txt", b"one"), (TOOL.APP_ROOT + "e\u0301.txt", b"two")],
            [(TOOL.APP_ROOT + "folder", b"file"), (TOOL.APP_ROOT + "folder/child", b"child")]
        ):
            with self.subTest(extra=extra):
                self.write_ipa(extra=extra)
                self.assert_rejected()

    def test_nul_in_original_zip_name_is_rejected_before_truncation(self):
        name = TOOL.APP_ROOT + "fixture-NULX-name"
        self.write_ipa(extra=[(name, b"fixture")])
        data = self.source.read_bytes().replace(b"fixture-NULX-name", b"fixture-NUL\x00-name")
        self.source.write_bytes(data)
        self.assert_rejected(message="unsafe ZIP path")

    def test_raw_backslash_zip_name_is_rejected_before_windows_normalization(self):
        self.write_ipa(extra=[("PayloadXbackslash", b"fixture")])
        # ZipInfo normalizes a backslash when constructing a ZIP on Windows;
        # alter both on-disk name records to represent an untrusted input ZIP.
        data = self.source.read_bytes().replace(b"PayloadXbackslash", b"Payload\\backslash")
        self.source.write_bytes(data)
        self.assert_rejected(message="unsafe ZIP path")

    def test_zip_symlinks_and_other_file_types_are_rejected(self):
        for kind in (stat.S_IFLNK, stat.S_IFIFO):
            with self.subTest(kind=kind):
                entry = zipfile.ZipInfo(TOOL.APP_ROOT + "link")
                entry.create_system = 3
                entry.external_attr = (kind | 0o777) << 16
                self.write_ipa(extra=[(entry, b"../../outside")])
                self.assert_rejected(message="unsupported file type")

    def test_input_and_existing_output_cannot_be_overwritten(self):
        original = self.source.read_bytes()
        result, stdout, stderr = self.run_cli("--input", str(self.source), "--output", str(self.source), "--env-file", str(self.env))
        self.assertEqual(result, 1)
        self.assertIn("separate IPA", stderr)
        self.assertEqual(self.source.read_bytes(), original)
        self.output.write_bytes(b"preexisting-private-output")
        result, stdout, stderr = self.run_cli()
        self.assertEqual(result, 1)
        self.assertIn("will not be overwritten", stderr)
        self.assertEqual(self.output.read_bytes(), b"preexisting-private-output")

    def test_existing_hard_link_alias_is_not_overwritten(self):
        os.link(self.source, self.output)
        original = self.source.read_bytes()
        result, _, _ = self.run_cli()
        self.assertEqual(result, 1)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(self.output.read_bytes(), original)

    def test_atomic_publication_does_not_overwrite_a_racing_destination(self):
        publish = TOOL._publish

        def competing_file(temporary, output):
            output.write_bytes(b"concurrent-output-must-survive")
            publish(temporary, output)

        with patch.object(TOOL, "_publish", side_effect=competing_file):
            result, _, _ = self.run_cli()
        self.assertEqual(result, 1)
        self.assertEqual(self.output.read_bytes(), b"concurrent-output-must-survive")
        self.assertEqual(list(self.root.glob(".ths-personal-*")), [])

    def test_failed_self_verification_leaves_no_personal_or_temporary_output(self):
        with patch.object(TOOL, "_verify_output", side_effect=ValueError(FAKE_SECRET)):
            self.assert_rejected()

    def test_self_verification_detects_changes_to_existing_data(self):
        verify = TOOL._verify_output

        def corrupt_before_verification(output, *args):
            data = bytearray(output.read_bytes())
            data[10] ^= 1
            output.write_bytes(data)
            verify(output, *args)

        with patch.object(TOOL, "_verify_output", side_effect=corrupt_before_verification):
            self.assert_rejected(message="existing compressed archive content")

    def test_invalid_zip_and_missing_files_redact_underlying_file_details(self):
        self.source.write_bytes(FAKE_SECRET.encode("utf-8"))
        self.assert_rejected()
        self.write_ipa()
        self.env.unlink()
        self.assert_rejected(message="input file is missing")

    def test_required_arguments_and_unrecognized_arguments_do_not_echo_input(self):
        result, stdout, stderr = self.run_cli("--input", str(self.source))
        self.assertEqual(result, 1)
        self.assertIn("Invalid arguments", stderr)
        result, stdout, stderr = self.run_cli("--unexpected", FAKE_SECRET)
        self.assertEqual(result, 1)
        self.assertNotIn(FAKE_SECRET, stdout + stderr)

    def test_zip_and_env_limits_fail_without_partial_output(self):
        with patch.object(TOOL, "MAX_ENTRY_BYTES", 4):
            self.assert_rejected(message="supported size")
        self.write_env("#" * (64 * 1024 + 1))
        self.assert_rejected(message="credential file is too large")


CONFIG_LOWER = TOOL.CONFIG_NAME.casefold()


if __name__ == "__main__":
    unittest.main()
