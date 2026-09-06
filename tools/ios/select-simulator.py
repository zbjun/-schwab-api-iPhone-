"""Select an existing available iPhone simulator on the current macOS runner."""
import json
import subprocess

devices = json.loads(subprocess.check_output(
    ["xcrun", "simctl", "list", "devices", "available", "--json"], text=True
))["devices"]
candidates = [
    (runtime, device)
    for runtime, values in devices.items()
    if ".iOS-" in runtime
    for device in values
    if device.get("isAvailable") and device.get("name", "").startswith("iPhone")
]
if not candidates:
    raise SystemExit("No available iPhone simulator exists on this runner.")

# Prefer the newest installed iOS runtime, without assuming a particular phone name.
def runtime_version(candidate):
    return tuple(int(part) for part in candidate[0].split(".iOS-")[-1].split("-"))

_, selected = max(candidates, key=lambda item: (runtime_version(item), item[1].get("name") == "iPhone 16 Pro"))
print(f"SIMULATOR_UDID={selected['udid']}")
print(f"SIMULATOR_NAME={selected['name']}")
