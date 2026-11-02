"""Fetch pinned official SDK references for local inspection; execute no package scripts."""
from pathlib import Path, PurePosixPath
from urllib.request import urlopen, Request
import base64, hashlib, io, json, tarfile

root = Path(__file__).resolve().parents[1] / '.sdk-reference'
version = '0.2.1-rc.3'
for short in ['dsh-ssh', 'dsh-fs-ssh', 'dsh-subprocess-ssh', 'dsh-sandbox-ssh']:
    name = '@deepseek-ai/' + short
    metadata_url = 'https://registry.npmjs.org/' + name + '/' + version
    with urlopen(Request(metadata_url, headers={'User-Agent': 'dsh-ssh-gateway-reference'}), timeout=30) as response:
        metadata = json.load(response)
    expected_url = f'https://registry.npmjs.org/@deepseek-ai/{short}/-/{short}-{version}.tgz'
    if metadata['dist']['tarball'] != expected_url:
        raise RuntimeError('Unexpected registry tarball URL')
    with urlopen(expected_url, timeout=30) as response:
        archive = response.read()
    digest = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode('ascii')
    if digest != metadata['dist']['integrity']:
        raise RuntimeError('Package integrity check failed: ' + name)
    destination = root / short
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
        for member in package.getmembers():
            relative = PurePosixPath(member.name)
            if not member.isfile() or relative.parts[0] != 'package' or '..' in relative.parts:
                continue
            target = destination.joinpath(*relative.parts[1:])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(package.extractfile(member).read())
    print(name + '@' + version + ': integrity verified, reference extracted')
