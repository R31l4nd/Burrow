import { describe, expect, it } from 'vitest';
import { guestAddress, parsePctList, parseQmList } from './proxmox.js';

describe('Proxmox guests (F5)', () => {
  it('reads qm list', () => {
    const out = [
      '      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID',
      '       100 ubuntu-24            running    2048              32.00 4112',
      '       101 win11                stopped    8192              64.00 0',
      'garbage line',
    ].join('\n');
    expect(parseQmList(out)).toEqual([
      { kind: 'vm', vmid: 100, name: 'ubuntu-24', status: 'running', lock: null },
      { kind: 'vm', vmid: 101, name: 'win11', status: 'stopped', lock: null },
    ]);
  });

  it('reads pct list, with and without a lock', () => {
    const out = ['VMID       Status     Lock         Name', '200        running                 pihole', '201        stopped    backup       nextcloud'].join('\n');
    expect(parsePctList(out)).toEqual([
      { kind: 'ct', vmid: 200, name: 'pihole', status: 'running', lock: null },
      { kind: 'ct', vmid: 201, name: 'nextcloud', status: 'stopped', lock: 'backup' },
    ]);
  });

  it('nothing but a header is no guests, not an error', () => {
    expect(parseQmList('      VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID\n')).toEqual([]);
    expect(parsePctList('')).toEqual([]);
  });

  it("a guest's address: a container's static ip, else what it says; a VM's from its agent", () => {
    expect(guestAddress('ct', 'arch: amd64\nnet0: name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1\n', '')).toBe('192.168.1.50');
    expect(guestAddress('ct', 'net0: name=eth0,bridge=vmbr0,ip=dhcp\n', '127.0.0.1 10.0.0.7 fd00::7')).toBe('10.0.0.7');
    expect(guestAddress('ct', 'net0: name=eth0,ip=dhcp\n', '')).toBeNull();
    const agent = JSON.stringify([
      { name: 'lo', 'ip-addresses': [{ 'ip-address-type': 'ipv4', 'ip-address': '127.0.0.1' }] },
      { name: 'ens18', 'ip-addresses': [{ 'ip-address-type': 'ipv6', 'ip-address': 'fe80::1' }, { 'ip-address-type': 'ipv4', 'ip-address': '192.168.1.60' }] },
    ]);
    expect(guestAddress('vm', '', agent)).toBe('192.168.1.60');
    expect(guestAddress('vm', '', 'QEMU guest agent is not running')).toBeNull();
  });
});
