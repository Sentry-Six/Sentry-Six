#!/usr/bin/env python3 -I
"""Memory and CPU time for an app and every process macOS attributes to it.

Same method as the Sentry Drive benchmark: a process belongs to the app when
it is the app's PID, a descendant, or a process macOS holds the app
"responsible" for (WebKit's WebContent/Networking/GPU XPC services, which
launchd starts). Memory is ri_phys_footprint (Activity Monitor's "Memory"
column); CPU is user+system time.

When the app is launched from a terminal (as the bench driver does, so the
app inherits the terminal's existing network-volume permission instead of
raising a new privacy prompt), macOS makes the *terminal* responsible for
WebKit's XPC services. Pass --since <epoch-seconds> to also count WebKit
services that share the app's responsible process and started at/after the
launch.

Usage: procstat.py <root-pid> [--since <epoch-seconds>]  -> one JSON object
"""
import datetime
import ctypes
import json
import subprocess
import sys

libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
responsible = libc.responsibility_get_pid_responsible_for_pid
responsible.restype = ctypes.c_int
responsible.argtypes = [ctypes.c_int]
proc_pid_rusage = libc.proc_pid_rusage
proc_pid_rusage.restype = ctypes.c_int
proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]


class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]


tb = Timebase()
libc.mach_timebase_info(ctypes.byref(tb))
TICK_NS = tb.numer / tb.denom


def rusage(pid):
    buf = (ctypes.c_uint8 * 1024)()
    if proc_pid_rusage(pid, 4, buf) != 0:  # RUSAGE_INFO_V4
        return None
    v = (ctypes.c_uint64 * 120).from_buffer(buf, 16)
    return {'cpu_ns': (v[0] + v[1]) * TICK_NS, 'footprint': v[7], 'peak_footprint': v[28]}


def main():
    root = int(sys.argv[1])
    since = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[2] == '--since' else None
    ps = subprocess.run(['ps', '-A', '-o', 'pid=,ppid=,lstart=,comm='], capture_output=True, text=True,
                        env={'LC_ALL': 'C', 'TZ': 'UTC'}).stdout
    rows, started = [], {}
    for line in ps.splitlines():
        p = line.strip().split(None, 7)
        if len(p) == 8:
            pid = int(p[0])
            rows.append((pid, int(p[1]), p[7]))
            t = datetime.datetime.strptime(' '.join(p[2:7]), '%a %b %d %H:%M:%S %Y')
            started[pid] = t.replace(tzinfo=datetime.timezone.utc).timestamp()
    members = {root} | {pid for pid, _, _ in rows if responsible(pid) == root}
    if since is not None:
        owner = responsible(root)
        members |= {pid for pid, _, comm in rows
                    if 'com.apple.WebKit.' in comm and responsible(pid) == owner and started.get(pid, 0) >= since - 1}
    grew = True
    while grew:
        grew = False
        for pid, ppid, _ in rows:
            if ppid in members and pid not in members:
                members.add(pid)
                grew = True
    procs = []
    for pid, _, comm in rows:
        if pid in members:
            u = rusage(pid)
            if u:
                procs.append({'pid': pid, 'name': comm.rsplit('/', 1)[-1], **u})
    print(json.dumps({
        'footprint': sum(p['footprint'] for p in procs),
        'cpu_ns': sum(p['cpu_ns'] for p in procs),
        'procs': procs,
    }))


main()
