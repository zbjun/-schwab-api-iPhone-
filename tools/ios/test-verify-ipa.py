"""Offline delivery checks, using synthetic command tables and fixture credentials."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SPEC = importlib.util.spec_from_file_location("verify_ipa", Path(__file__).with_name("verify-ipa.py"))
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


class VerifyIPATests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ths-verify-tests-")
        self.addCleanup(temporary.cleanup)
        self.ipa = Path(temporary.name) / "fixture.ipa"
        self.config = {"schemaVersion": 1, "clientID": "fixture-client", "clientSecret": "fixture-secret"}

    def write_ipa(self, configuration=None, *, marker=True, debug_switch=b""):
        info = {"CFBundleName": "THS", "CFBundleIdentifier": "app.personal.ths", "CFBundleExecutable": "THS",
                "CFBundleShortVersionString": "0.4.2", "CFBundleVersion": "6", "DTPlatformName": "iphoneos",
                "CFBundleSupportedPlatforms": ["iPhoneOS"]}
        if marker:
            info["THSPersonalConfigurationVersion"] = 1
        commands = struct.pack("<6I", 0x32, 24, 2, 0x110000, 0x1A0500, 0)
        executable = struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 2, 1, len(commands), 0, 0) + commands + debug_switch
        with zipfile.ZipFile(self.ipa, "w") as archive:
            archive.writestr("Payload/THS.app/Info.plist", plistlib.dumps(info))
            archive.writestr("Payload/THS.app/THS", executable)
            if configuration is not None:
                payload = configuration if isinstance(configuration, bytes) else plistlib.dumps(configuration)
                archive.writestr("Payload/THS.app/SchwabPersonalConfiguration.plist", payload)

    def verify(self, *, personal=False):
        args = ["verify-ipa.py", str(self.ipa), "--version", "0.4.2", "--build", "6"]
        if personal:
            args.append("--personal")
        output = io.StringIO()
        with patch.object(sys, "argv", args), redirect_stdout(output):
            VERIFY.main()
        rendered = output.getvalue()
        self.assertNotIn("fixture-client", rendered)
        self.assertNotIn("fixture-secret", rendered)
        return json.loads(rendered)

    def test_generic_archive_allows_absent_configuration_and_legacy_marker(self):
        self.write_ipa(marker=False)
        self.assertEqual(self.verify()["personal_configuration"], "absent")

    def test_generic_cloud_archive_rejects_personal_configuration(self):
        self.write_ipa(self.config)
        with self.assertRaisesRegex(SystemExit, "must not contain personal"):
            self.verify()

    def test_personal_archive_requires_configuration(self):
        self.write_ipa()
        with self.assertRaisesRegex(SystemExit, "Expected exactly one personal"):
            self.verify(personal=True)

    def test_personal_archive_reports_only_metadata(self):
        self.write_ipa(self.config)
        report = self.verify(personal=True)
        self.assertEqual(report["personal_configuration"], "embedded_locally")
        self.assertFalse(report["physical_iphone_tested"])

    def test_old_binary_cannot_be_presented_as_supporting_personal_configuration(self):
        self.write_ipa(self.config, marker=False)
        with self.assertRaisesRegex(SystemExit, "does not support personal"):
            self.verify(personal=True)

    def test_invalid_configuration_is_rejected_without_echoing_content(self):
        variants = [b"fixture-secret invalid plist", b"x" * 4097,
                    {**self.config, "schemaVersion": True}, {**self.config, "schemaVersion": 2},
                    {**self.config, "clientID": "fixture:client"}, {**self.config, "clientSecret": "fixture secret"},
                    {**self.config, "clientSecret": "fixture\u200bsecret"}, {**self.config, "clientID": ""},
                    {**self.config, "clientSecret": "a" * 513}, {**self.config, "token": "fixture-token"}]
        for configuration in variants:
            with self.subTest(configuration_type=type(configuration).__name__):
                self.write_ipa(configuration)
                with self.assertRaises(SystemExit) as failure:
                    self.verify(personal=True)
                self.assertNotIn("fixture-secret", str(failure.exception))
                self.assertNotIn("fixture-token", str(failure.exception))

    def test_release_rejects_all_native_ui_fixture_switches(self):
        for flag in (b"--uitesting-demo", b"--snapshot-tab", b"--uitesting-personal-config"):
            with self.subTest(flag=flag):
                self.write_ipa(debug_switch=flag)
                with self.assertRaisesRegex(SystemExit, "UI test launch switches"):
                    self.verify()


if __name__ == "__main__":
    unittest.main()
