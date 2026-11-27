import { describe, expect, test } from 'bun:test';
import { allowlist, canonical, nft, parse } from './priamo.ts';

describe('canonical', () => {
  test('compresses and lower-cases a Yggdrasil address, with or without brackets', () => {
    expect(canonical('[0201:0DB8:0000:0000:0000:0000:0000:0001]')).toBe('201:db8::1');
    expect(canonical(' 3ff:ffff::1 ')).toBe('3ff:ffff::1');
  });
  test('refuses what is not 200::/7', () => {
    for (const a of ['1ff:ffff::1', '400::1', '2001:db8::1', 'fc00::1', '::ffff:2.0.0.1', '10.0.0.1', 'ygg.example']) {
      expect(() => canonical(a)).toThrow();
    }
  });
});

describe('parse', () => {
  test('defaults the interface and port, refuses a contact twice', () => {
    const p = parse('{"contacts":[{"name":"A","address":"201:db8::1"}]}');
    expect(p).toEqual({ interface: 'ygg0', port: 8448, contacts: [{ name: 'A', address: '201:db8::1' }] });
    expect(() => parse('{"contacts":[{"name":"A","address":"201:db8::1"},{"name":"B","address":"201:DB8:0::1"}]}')).toThrow();
  });
  test('refuses an interface name nft could misread', () => {
    expect(() => parse('{"interface":"ygg0\\" accept","contacts":[]}')).toThrow();
  });
});

describe('render', () => {
  const p = parse('{"interface":"tun9","port":8449,"contacts":[{"name":"A","address":"201:db8::1"},{"name":"B","address":"300::2"}]}');
  test('the firewall lets only contacts reach the port and keeps 200::/7 on the overlay', () => {
    const out = nft(p);
    expect(out).toContain('elements = { 201:db8::1, 300::2 }');
    expect(out).toContain('iifname "tun9" ip6 saddr @contacts tcp dport 8449 accept');
    expect(out).toContain('iifname "tun9" drop');
    expect(out).toContain('ip6 daddr 200::/7 oifname != "tun9" reject');
  });
  test('the allowlist names the same servers, with or without a port', () => {
    const out = allowlist(p);
    const patterns = [...out.matchAll(/'([^']+)'/g)].map((m) => new RegExp(m[1] ?? ''));
    const allowed = (name: string) => patterns.some((r) => r.test(name));
    expect(allowed('[201:db8::1]')).toBe(true);
    expect(allowed('[300::2]:8449')).toBe(true);
    expect(allowed('[201:db8::11]')).toBe(false);
    expect(allowed('x[201:db8::1]')).toBe(false);
  });
  test('no contacts allows no server instead of every server', () => {
    const empty = parse('{"contacts":[]}');
    expect(allowlist(empty)).toContain("['^$']");
    expect(nft(empty)).not.toContain('elements');
  });
});
