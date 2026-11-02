#!/usr/bin/env python3
"""Make proc-macro dylibs loadable on macOS 27.2.

Apple's ld-27106 puts the LINKEDIT string pool right behind the indirect symbol
table. That table holds four-byte entries, so an odd number of them leaves the
string pool on a 4-byte boundary, and dyld on macOS 27.2 refuses to load such a
dylib: `mis-aligned LINKEDIT string pool`. rustc reports that as `can't find
crate for serde_derive` (or tauri_macros, phf_macros, thiserror_impl, ...) and it
looks like a broken cargo cache, which it is not. Roughly half the proc macros in
the tree are hit, which is why CI on macos-latest keeps passing.

The parity follows the crate's imported symbols, so no rustc or linker flag moves
it: strip, opt-level, codegen-units, -Wl,-no_function_starts and bind_at_load all
land on the same offset. So the Mach-O is padded after the link instead: four zero
bytes ahead of the string pool, every offset behind it moved, the stale ad-hoc
signature dropped, and codesign puts a fresh one back.

As a rustc wrapper, for `pnpm tauri:build` and for `cargo check`:

    RUSTC_WRAPPER=$PWD/scripts/rustc-align.py cargo check --manifest-path src-tauri/Cargo.toml

Cargo keeps a dylib it has already built, stale or not, and only replays its old
stderr, so artifacts from a build that ran without the wrapper have to be repaired
(or deleted) by hand:

    scripts/rustc-align.py --sweep src-tauri/target
"""
import os
import struct
import subprocess
import sys

LC_SEGMENT_64, LC_SYMTAB, LC_DYSYMTAB, LC_CODE_SIGNATURE = 0x19, 0x2, 0xB, 0x1D
PAGE = 0x4000


def string_pool_offset(path):
    """Where LC_SYMTAB's string pool starts, or None when there is no symbol table."""
    try:
        with open(path, "rb") as f:
            head = f.read(32)
            if len(head) < 32 or struct.unpack_from("<I", head, 0)[0] != 0xFEEDFACF:
                return None
            ncmds = struct.unpack_from("<I", head, 16)[0]
            f.seek(32)
            for _ in range(ncmds):
                cmd, size = struct.unpack("<II", f.read(8))
                body = f.read(size - 8)
                if cmd == LC_SYMTAB:
                    return struct.unpack_from("<I", body, 8)[0]
    except (OSError, struct.error):
        return None
    return None


def align(path):
    """Pad the dylib so its string pool is 8-byte aligned. Returns None, or why not."""
    data = bytearray(open(path, "rb").read())
    if struct.unpack_from("<I", data, 0)[0] != 0xFEEDFACF:
        return "not a 64-bit Mach-O"
    ncmds, sizeofcmds = struct.unpack_from("<II", data, 16)
    symtab = sig = linkedit = None
    pos, cmds = 32, []
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", data, pos)
        cmds.append((cmd, size, pos))
        if cmd == LC_SYMTAB:
            symtab = pos
        elif cmd == LC_CODE_SIGNATURE:
            sig = pos
        elif cmd == LC_SEGMENT_64 and bytes(data[pos + 8:pos + 24]).rstrip(b"\0") == b"__LINKEDIT":
            linkedit = pos
        pos += size
    if symtab is None or linkedit is None:
        return "no symbol table or no __LINKEDIT"
    stroff, strsize = struct.unpack_from("<II", data, symtab + 16)
    pad = (8 - stroff % 8) % 8
    if pad == 0:
        return None

    # Only the signature may sit behind the string pool; everything else would move.
    for cmd, size, p in cmds:
        if cmd == LC_DYSYMTAB:
            f = struct.unpack_from("<18I", data, p + 8)
            if any(off > stroff for off in (f[6], f[8], f[10], f[12], f[14], f[16])):
                return "a dysymtab table sits behind the string pool"
    sigoff = struct.unpack_from("<I", data, sig + 8)[0] if sig is not None else len(data)
    if sigoff < stroff + strsize:
        return "the signature overlaps the string pool"

    out = data[:stroff] + bytearray(pad) + data[stroff:stroff + strsize]
    struct.pack_into("<I", out, symtab + 16, stroff + pad)

    # Drop LC_CODE_SIGNATURE and leave its bytes as header padding, which is where
    # codesign writes the new one. The load commands keep their file offsets.
    if sig is not None:
        size = next(c[1] for c in cmds if c[2] == sig)
        out = out[:sig] + out[sig + size:32 + sizeofcmds] + bytearray(size) + out[32 + sizeofcmds:]
        struct.pack_into("<II", out, 16, ncmds - 1, sizeofcmds - size)

    # segment_command_64: +24 vmaddr, +32 vmsize, +40 fileoff, +48 filesize
    fileoff = struct.unpack_from("<Q", out, linkedit + 40)[0]
    filesize = len(out) - fileoff
    struct.pack_into("<Q", out, linkedit + 48, filesize)
    struct.pack_into("<Q", out, linkedit + 32, (filesize + PAGE - 1) // PAGE * PAGE)

    tmp = path + ".aligned"
    with open(tmp, "wb") as f:
        f.write(out)
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
    signed = subprocess.run(["codesign", "-f", "-s", "-", tmp], capture_output=True, text=True)
    if signed.returncode != 0:
        os.unlink(tmp)
        return "codesign: " + (signed.stderr or "").strip().splitlines()[-1][:120]
    os.replace(tmp, path)
    return None


def sweep(roots):
    """Repair every misaligned dylib under the given directories."""
    bad = 0
    for root in roots:
        for dirpath, _, names in os.walk(root):
            for name in names:
                if not name.endswith(".dylib"):
                    continue
                path = os.path.join(dirpath, name)
                offset = string_pool_offset(path)
                if offset is None or offset % 8 == 0:
                    continue
                bad += 1
                err = align(path)
                print("%s %s" % ("could not align" if err else "aligned", name) + (": " + err if err else ""))
    print("nothing to align" if not bad else "%d dylib(s) looked at" % bad)
    return 0


def wrap(args):
    """Run rustc, then align the proc-macro dylib it just linked."""
    def val(flag):
        for i, a in enumerate(args):
            if a == flag and i + 1 < len(args):
                return args[i + 1]
            if a.startswith(flag + "="):
                return a.split("=", 1)[1]
        return None

    rc = subprocess.call(args)
    if rc != 0 or val("--crate-type") != "proc-macro" or "link" not in (val("--emit") or ""):
        return rc

    name = (val("--crate-name") or "").replace("-", "_")
    out = val("--out-dir")
    extra = ""
    for i, a in enumerate(args):
        if a == "-C" and i + 1 < len(args) and args[i + 1].startswith("extra-filename="):
            extra = args[i + 1].split("=", 1)[1]
        elif a.startswith("-Cextra-filename="):
            extra = a.split("=", 1)[1]
    if not name or not out:
        return 0
    path = os.path.join(out, "lib%s%s.dylib" % (name, extra))
    if os.path.exists(path):
        err = align(path)
        if err:
            sys.stderr.write("rustc-align: %s: %s\n" % (os.path.basename(path), err))
    return 0


if __name__ == "__main__":
    argv = sys.argv[1:]
    if not argv:
        sys.exit("usage: rustc-align.py --sweep <dir>... | <rustc> <args>...   (see the docstring)")
    if argv[0] == "--sweep":
        sys.exit(sweep(argv[1:] or ["src-tauri/target"]))
    sys.exit(wrap(argv))
