"""Packaging regression tests, using only invented credentials and synthetic binaries."""
import importlib.util
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile

SCRIPTS = Path(__file__).parent
spec = importlib.util.spec_from_file_location("personalizer", SCRIPTS / "personalize-ipa.py")
personalizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(personalizer)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "public.ipa"
        self.output = self.root / "private.ipa"
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"version": 1, "clientID": "fixture_client", "clientSecret": "fixture_secret"}))
        with zipfile.ZipFile(self.source, "w") as z:
            z.writestr("Payload/THS.app/Info.plist", plistlib.dumps({
                "CFBundleIdentifier": "app.personal.ths.expo", "CFBundleVersion": "1", "CFBundleShortVersionString": "test",
                "CFBundleExecutable": "THS", "DTPlatformName": "iphoneos", "CFBundleSupportedPlatforms": ["iPhoneOS"],
            }))
            binary = struct.pack("<8I", 0xFEEDFACF, 0x0100000C, 0, 2, 1, 24, 0, 0) + struct.pack("<6I", 0x32, 24, 2, 0, 0, 0)
            z.writestr("Payload/THS.app/THS", binary)
            z.writestr("Payload/THS.app/main.jsbundle", bytes.fromhex("c61fbc03c103191f") + bytes(10001))

    def test_inject_and_explicit_verification(self):
        before = self.source.read_bytes()
        report = personalizer.personalize(self.source, self.config, self.output)
        self.assertNotIn("fixture_secret", json.dumps(report))
        self.assertEqual(self.source.read_bytes(), before)
        with zipfile.ZipFile(self.output) as z:
            value = json.loads(z.read("Payload/THS.app/THSPersonalConfiguration.json"))
            self.assertEqual(value["clientSecret"], "fixture_secret")
        command = [sys.executable, str(SCRIPTS / "verify-ipa.py"), str(self.output), "--version", "test"]
        rejected = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(rejected.returncode, 0)
        allowed = subprocess.run(command + ["--allow-personal-config"], capture_output=True, text=True)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(json.loads(allowed.stdout)["personal_config"], "present")
        self.assertNotIn("fixture_secret", rejected.stderr + allowed.stdout + allowed.stderr)

    def test_refuses_overwrite_and_source_mutation(self):
        with self.assertRaises(ValueError):
            personalizer.personalize(self.source, self.config, self.source)
        self.output.write_text("keep")
        with self.assertRaises(ValueError):
            personalizer.personalize(self.source, self.config, self.output)
        self.assertEqual(self.output.read_text(), "keep")

    def test_rejects_unsafe_zip_and_repeat_personalization(self):
        personalizer.personalize(self.source, self.config, self.output)
        with self.assertRaises(ValueError):
            personalizer.personalize(self.output, self.config, self.root / "again.ipa")
        with zipfile.ZipFile(self.source, "a") as z:
            z.writestr("../unexpected", "fixture")
        with self.assertRaises(ValueError):
            personalizer.personalize(self.source, self.config, self.root / "unsafe.ipa")

    def test_bad_config_does_not_leak_secrets_or_write_output(self):
        for raw in [b"fixture_secret", b"null", b" " * 16385,
                    json.dumps({"version": 1, "clientID": "id", "clientSecret": "fixture_secret", "accessToken": "forbidden"}).encode()]:
            self.config.write_bytes(raw)
            result = subprocess.run([sys.executable, str(SCRIPTS / "personalize-ipa.py"), str(self.source), str(self.output), "--config", str(self.config)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("fixture_secret", result.stdout + result.stderr)
            self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
