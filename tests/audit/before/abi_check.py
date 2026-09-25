# Independent ABI encoder (no JS, no viem) used to re-encode SyncNet's launch calldata byte-for-byte.
import json, sys
from keccak import keccak256, selector

def is_dynamic(t):
    k = t[0]
    if k in ('string', 'bytes'): return True
    if k == 'array': return True
    if k == 'tuple': return any(is_dynamic(c) for c in t[1])
    return False

def enc_static(t, v):
    k = t[0]
    if k == 'address': return bytes(12) + bytes.fromhex(v[2:].lower().rjust(40, '0'))
    if k == 'uint': return int(v).to_bytes(32, 'big')
    if k == 'int':
        n = int(v); return (n % (1 << 256)).to_bytes(32, 'big')
    if k == 'bool': return (1 if v else 0).to_bytes(32, 'big')
    if k == 'bytes32': return bytes.fromhex(v[2:])
    raise ValueError(k)

def enc(t, v):
    k = t[0]
    if k in ('string', 'bytes'):
        b = v.encode('utf-8') if k == 'string' else bytes.fromhex(v[2:])
        pad = (32 - len(b) % 32) % 32
        return len(b).to_bytes(32, 'big') + b + bytes(pad)
    if k == 'array':
        return len(v).to_bytes(32, 'big') + enc_tuple([t[1]] * len(v), v)
    if k == 'tuple':
        return enc_tuple(t[1], v)
    return enc_static(t, v)

def enc_tuple(types, vals):
    heads, tails = [], []
    head_len = sum(32 if is_dynamic(t) else (len(enc(t, v))) for t, v in zip(types, vals))
    for t, v in zip(types, vals):
        if is_dynamic(t):
            heads.append(None); tails.append(enc(t, v))
        else:
            heads.append(enc(t, v)); tails.append(b'')
    out, off = b'', head_len
    for h, tl in zip(heads, tails):
        if h is None:
            out += off.to_bytes(32, 'big'); off += len(tl)
        else:
            out += h
    return out + b''.join(tails)

S = ('string',); A = ('address',); U = ('uint',); B32 = ('bytes32',); BOOL = ('bool',); I = ('int',)
SOCIALS = ('tuple', [S, S, S, S, S])
TP = ('tuple', [S, S, S, S, SOCIALS, A, U, B32, B32])
KEY = ('tuple', [A, A, U, I, A])
HOP = ('tuple', [KEY, BOOL])
LEG = ('tuple', [U, ('array', HOP), U])

d = json.load(open(sys.argv[1]))
ok_all = True
for case in d:
    p = case['params']
    tp = [p['name'], p['symbol'], p['logo'], p['description'],
          [p['socials']['twitter'], p['socials']['telegram'], p['socials']['discord'], p['socials']['website'], p['socials']['farcaster']],
          p['creatorFeeRecipient'], p['creatorTaxBps'], p['expectedEconomics'], p['salt']]
    if case['path'] == 'direct':
        sig = 'launchToken((string,string,string,string,(string,string,string,string,string),address,uint16,bytes32,bytes32),uint256,address[])'
        body = enc_tuple([TP, U, ('array', A)], [tp, 0, case['pairTokens']])
    else:
        sig = 'launchAndBuyWithEth((string,string,string,string,(string,string,string,string,string),address,uint16,bytes32,bytes32),uint256,address[],(uint8,((address,address,uint24,int24,address),bool)[],uint256)[],uint256)'
        raw = case['rawLegs']
        legs = []
        for leg in case['legs']:
            q = case['pairTokens'][leg['market']].lower()
            hops = list(reversed(raw[q]))  # pricer order is quote->ETH; a buy walks ETH->quote
            legs.append([leg['market'], [[[h['key']['currency0'], h['key']['currency1'], h['key']['fee'], h['key']['tickSpacing'], h['key']['hooks']], h['v3']] for h in hops], int(leg['ethWei'])])
        body = enc_tuple([TP, U, ('array', A), ('array', LEG), U], [tp, 0, case['pairTokens'], legs, int(case['minTokens'])])
    mine = selector(sig) + body.hex()
    same = mine == case['data'].lower()
    ok_all &= same
    print(case['path'], 'selector', selector(sig), 'bytes', len(body) + 4, 'IDENTICAL' if same else 'DIFFERENT')
    if not same:
        a, b = mine, case['data'].lower()
        i = next(i for i in range(min(len(a), len(b))) if a[i] != b[i]); print('  first diff at hex char', i)
print('ALL IDENTICAL' if ok_all else 'MISMATCH')
