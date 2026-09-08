"""Create this owner's private, one-time Expo Go import file without bundling secrets."""
import json
from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
parser = runpy.run_path(str(root / 'tools' / 'ios' / 'personalize-ipa.py'))
try:
    configuration = parser['read_configuration'](root / '.env')
    destination = root / 'artifacts' / 'THS-Expo-personal-config.json'
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps({
        'version': 1, 'clientID': configuration['clientID'],
        'clientSecret': configuration['clientSecret'],
    }), encoding='utf-8')
    print('Private Expo configuration file created in artifacts; credentials were not printed.')
except Exception:
    raise SystemExit('Could not export the private configuration; check the local .env file.') from None
