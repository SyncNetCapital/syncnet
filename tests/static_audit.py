#!/usr/bin/env python3
from pathlib import Path
import re, json, sys
ROOT=Path(__file__).resolve().parents[1]
errors=[]

def fail(msg): errors.append(msg)

index=(ROOT/'index.html').read_text(errors='replace')
product=(ROOT/'product-lab.js').read_text(errors='replace')
network=(ROOT/'network-explorer.js').read_text(errors='replace')
launch=(ROOT/'launch-controller.js').read_text(errors='replace')

# Canonical addresses used by the public client.
USDG='0x5fc5360d0400a0fd4f2af552add042d716f1d168'
for f in ['product-lab.js','project-services.js','network-explorer.js']:
    text=(ROOT/f).read_text(errors='replace').lower()
    if USDG not in text: fail(f'{f}: canonical USDG address missing')
if '0x39db3b22af299a80e56c74a81d072c011aa343b5' in network.lower(): fail('network-explorer.js: stale USDG address present')

# Required token-route shell.
for id_ in ['homeView','tokenView','tokenPageContent']:
    if not re.search(r'id=["\']'+re.escape(id_)+r'["\']',index): fail(f'index.html: missing #{id_}')

# Public build should not ship the dormant unpublished identity service client.
if (ROOT/'identity-client.js').exists(): fail('identity-client.js should not be in public build')

# No obvious secret material.
secret_patterns=[r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',r'\b(?:sk-proj-|ghp_|github_pat_)\w{12,}',r'\b(?:mnemonic|seed phrase)\s*[:=]\s*["\'][^"\']+["\']']
for path in ROOT.rglob('*'):
    if path.is_file() and path.stat().st_size<2_000_000:
        text=path.read_text(errors='ignore')
        for pat in secret_patterns:
            if re.search(pat,text,re.I): fail(f'{path.relative_to(ROOT)}: possible secret pattern')

# No embedded base64 hero image after cleanup.
if 'class="logo" src="data:image/' in index: fail('index.html: hero logo is still embedded as base64')
if not (ROOT/'assets'/'syncnet-logo.png').exists(): fail('assets/syncnet-logo.png missing')

# Confirmed journal must not be rewritten to pending on boot.
if "state:'confirmed'){record={...record,state:'pending'" in launch: fail('launch-controller.js: confirmed record downgrade still present')

# Public status pages should not advertise stale internal release blockers.
for f in ['terms.html','privacy.html','contact.html','risk.html']:
    text=(ROOT/f).read_text(errors='replace')
    if 'PRODUCTION BLOCKER' in text or 'OPERATOR INFORMATION REQUIRED' in text: fail(f'{f}: stale internal blocker label present')


# Public beta v1.1.7 must not submit new wallet transactions.
app_sources=['index.html','product-lab.js','project-services.js','network-explorer.js','launch-engine.js','launch-controller.js']
for f in app_sources:
    text=(ROOT/f).read_text(errors='replace')
    if 'eth_sendTransaction' in text:
        fail(f'{f}: transaction submission method present in simulation-only public build')
if 'SIMULATION ONLY' not in index.upper():
    fail('index.html: simulation-only public-beta disclosure missing')

# Registry must parse.
try: json.loads((ROOT/'syncnet-projects.json').read_text())
except Exception as e: fail(f'syncnet-projects.json invalid: {e}')

if errors:
    print('STATIC AUDIT FAILED')
    for e in errors: print(' -',e)
    sys.exit(1)
print('STATIC AUDIT PASSED')
