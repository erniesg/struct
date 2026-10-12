#!/usr/bin/env python3
"""Atomically move a completed local directory without replacing a destination."""
import ctypes
import errno
import json
import os
import sys


def publish(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        # macOS SDK sys/stdio.h: RENAME_EXCL = 0x00000004.
        operation = libc.renamex_np
        operation.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        operation.restype = ctypes.c_int
        result = operation(os.fsencode(source), os.fsencode(destination), 4)
    elif sys.platform.startswith('linux'):
        # Linux renameat2: AT_FDCWD = -100, RENAME_NOREPLACE = 1.
        operation = libc.renameat2
        operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        operation.restype = ctypes.c_int
        result = operation(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
    else:
        raise OSError(errno.ENOTSUP, 'unsupported platform')
    if result != 0:
        number = ctypes.get_errno()
        raise OSError(number, 'exclusive publication failed')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise OSError(errno.EINVAL, 'invalid arguments')
        publish(sys.argv[1], sys.argv[2])
    except (OSError, AttributeError) as error:
        number = getattr(error, 'errno', None) or errno.ENOTSUP
        print(json.dumps({'ok': False, 'code': errno.errorcode.get(number, 'EIO')}))
        sys.exit(1)
    print(json.dumps({'ok': True}))
