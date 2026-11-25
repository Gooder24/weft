#!/usr/bin/env python3
"""send-later's pacing (`gap`, Rozoslať) against an in-memory homeserver, the clock passed in: nothing sleeps.

Run: python3 tests/sendlater/gap_test.py   (exits 1 on a failure; reaches no server)"""
import copy, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../server/sendlater'))
import sendlater  # noqa: E402

USER = '@me:test'
KEY = f'/_matrix/client/v3/user/%40me%3Atest/account_data/{sendlater.KEY}'


class FakeHS:
    """Account data and sent messages; a transaction id goes through once, as on a real homeserver."""
    def __init__(self, items):
        self.data = {'items': copy.deepcopy(items)}
        self.sent, self.txns = [], set()

    def call(self, method, path, body=None, token=None, timeout=60):
        if path == KEY:
            if method == 'GET': return copy.deepcopy(self.data)
            self.data = copy.deepcopy(body); return {}
        if '/send/m.room.message/' in path and method == 'PUT':
            txn = path.rsplit('/', 1)[1]
            if txn not in self.txns:
                self.txns.add(txn)
                self.sent.append((txn, body))
            return {'event_id': f'$ev-{txn}'}
        if path.endswith('/state'): return []  # no Discord rooms here
        raise AssertionError(f'unexpected {method} {path}')


failed = 0
def check(name, ok, info=''):
    global failed
    failed += not ok
    print(f"{'PASS' if ok else 'FAIL'}: {name}{' · ' + str(info) if info else ''}")


def batch(bc, person, room, net, at, parts=2):
    return [{'id': f'bc-{bc}-{person}-{seq}', 'room': room, 'net': net, 'at': at, 'seq': seq, 'batch': f'bc-{bc}-{person}',
             'gap': 25_000, 'content': {'msgtype': 'm.text', 'body': f'{person} {seq}'}} for seq in range(parts)]


T0 = 1_800_000_000_000
# Four people due a few seconds apart; the service was down for an hour and comes back at T0 + 1 h.
items = (batch('x', 'a', '!a', 'messenger', T0) + batch('x', 'b', '!b', 'messenger', T0 + 30_000)
         + batch('x', 'c', '!c', 'whatsapp', T0 + 60_000) + batch('x', 'd', '!d', 'messenger', T0 + 90_000, parts=1)
         + [{'id': 'plain', 'room': '!a', 'at': T0, 'seq': 0, 'content': {'msgtype': 'm.text', 'body': 'later'}}])
hs = FakeHS(items)
sendlater.call = hs.call
now = T0 + 3600_000
sendlater.send_due('tok', USER, now)
ids = [t for t, _ in hs.sent]
check('po výpadku odíde z každej siete len jedno rozoslanie (text aj príloha), obyčajná správa hneď',
      sorted(ids) == ['bc-x-a-0', 'bc-x-a-1', 'bc-x-c-0', 'bc-x-c-1', 'plain'], ids)
check('ďalšie je na rade až o gap', sendlater.next_due('tok', USER) == now + 25_000, sendlater.next_due('tok', USER) - now)
sendlater.send_due('tok', USER, now + 10_000)
check('o 10 s nič', len(hs.sent) == 5, [t for t, _ in hs.sent][5:])
sendlater.send_due('tok', USER, now + 25_000)
check('o 25 s ďalší z Messengeru, celý', [t for t, _ in hs.sent][5:] == ['bc-x-b-0', 'bc-x-b-1'], [t for t, _ in hs.sent][5:])
sendlater.send_due('tok', USER, now + 40_000)
check('o 40 s nič (od b len 15 s)', len(hs.sent) == 7)
sendlater.send_due('tok', USER, now + 50_000)
check('o 50 s posledný', [t for t, _ in hs.sent][7:] == ['bc-x-d-0'], [t for t, _ in hs.sent][7:])
check('každá položka je označená ako odoslaná', all(it.get('sent') for it in hs.data['items']))
check('nič neodišlo dvakrát', len(hs.sent) == len({t for t, _ in hs.sent}) == 8)
check('nič už nečaká', sendlater.next_due('tok', USER) is None)

# Two confirmations wrote the same ids twice (two devices): each still goes once.
hs = FakeHS(batch('y', 'a', '!a', 'messenger', T0) + batch('y', 'a', '!a', 'messenger', T0))
sendlater.call = hs.call
sendlater.send_due('tok', USER, T0 + 1000)
check('rovnaké id dvakrát v zozname odíde raz', [t for t, _ in hs.sent] == ['bc-y-a-0', 'bc-y-a-1'], [t for t, _ in hs.sent])

# The text was refused: its file never goes alone.
hs = FakeHS(batch('z', 'a', '!a', 'messenger', T0))
hs.data['items'][0]['failed'] = T0
sendlater.call = hs.call
sendlater.send_due('tok', USER, T0 + 1000)
rest = hs.data['items'][1]
check('keď text neodíde, príloha za ním tiež nie', not hs.sent and rest.get('failed') and 'before' in rest.get('error', ''), rest)

# A paced batch on its own network does not wait for another network's.
hs = FakeHS(batch('w', 'a', '!a', 'messenger', T0, 1) + batch('w', 'b', '!b', 'discord', T0, 1) + batch('w', 'c', '!c', 'instagram', T0, 1))
sendlater.call = hs.call
sendlater.send_due('tok', USER, T0 + 1000)
check('tri siete naraz: každá po jednej', len(hs.sent) == 3, [t for t, _ in hs.sent])

sys.exit(1 if failed else 0)
