#!/usr/bin/env python3
"""Streaming AES-256-GCM encryption for backup archives.

File format (compatible with the backup tooling of the other projects on the
author's host): MAGIC "FBACKUP1" | salt[16] | nonce[12] | ciphertext | tag[16].
The file key is PBKDF2-HMAC-SHA256(master, salt, 600k) so a leaked archive
cannot be attacked with the key file's structure in mind.

Usage: crypto.py encrypt|decrypt SOURCE TARGET KEYFILE
"""

import base64
import hashlib
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = b"FBACKUP1"
CHUNK = 1024 * 1024


def load_key(filename):
    raw = Path(filename).read_bytes()
    text = raw.strip()
    candidates = [raw, text]
    try:
        candidates.append(bytes.fromhex(text.decode()))
    except (ValueError, UnicodeDecodeError):
        pass
    try:
        candidates.append(base64.b64decode(text, validate=True))
    except (ValueError, UnicodeDecodeError):
        pass
    for c in candidates:
        if len(c) == 32:
            return c
    # A passphrase of any other length is stretched instead of refused, so
    # `openssl rand -base64 48` works as documented in secrets/README.md.
    if len(text) >= 32:
        return hashlib.sha256(text).digest()
    raise SystemExit("The backup key must be 32 bytes, 64 hex characters, base64, or a passphrase of 32+ characters.")


def file_key(master, salt):
    return hashlib.pbkdf2_hmac("sha256", master, salt, 600_000, dklen=32)


def encrypt(source, target, master):
    salt, nonce = os.urandom(16), os.urandom(12)
    enc = Cipher(algorithms.AES(file_key(master, salt)), modes.GCM(nonce)).encryptor()
    with open(source, "rb") as src, open(target, "wb") as dst:
        dst.write(MAGIC + salt + nonce)
        while chunk := src.read(CHUNK):
            dst.write(enc.update(chunk))
        dst.write(enc.finalize())
        dst.write(enc.tag)


def decrypt(source, target, master):
    size = Path(source).stat().st_size
    header = len(MAGIC) + 16 + 12
    if size < header + 16:
        raise SystemExit("The encrypted backup is too short.")
    with open(source, "rb") as src:
        if src.read(len(MAGIC)) != MAGIC:
            raise SystemExit("Not a backup file of this format.")
        salt, nonce = src.read(16), src.read(12)
        src.seek(-16, os.SEEK_END)
        tag = src.read(16)
        src.seek(header)
        remaining = size - header - 16
        dec = Cipher(algorithms.AES(file_key(master, salt)), modes.GCM(nonce, tag)).decryptor()
        with open(target, "wb") as dst:
            while remaining:
                chunk = src.read(min(CHUNK, remaining))
                if not chunk:
                    raise SystemExit("The encrypted backup is truncated.")
                dst.write(dec.update(chunk))
                remaining -= len(chunk)
            # Raises InvalidTag when the key is wrong or the file was altered.
            dst.write(dec.finalize())


def main():
    if len(sys.argv) != 5 or sys.argv[1] not in {"encrypt", "decrypt"}:
        raise SystemExit("Usage: crypto.py encrypt|decrypt SOURCE TARGET KEYFILE")
    op, source, target, key_file = sys.argv[1:]
    key = load_key(key_file)
    try:
        (encrypt if op == "encrypt" else decrypt)(source, target, key)
    except BaseException:
        # Never leave a half-written file that could pass for a backup.
        Path(target).unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    main()
