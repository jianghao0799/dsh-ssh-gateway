"""Ephemeral stdlib-only request worker; stdin EOF cancels active execution."""
import base64
import fnmatch
import hashlib
import json
import mimetypes
import os
import platform
import re
import signal
import stat
import socket
import subprocess
import sys
import tempfile
import threading
import time

FILE_MAX = 4 * 1024 * 1024
OUTPUT_MAX = 1024 * 1024
cancelled = threading.Event()

class RequestError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message

def fail(code, message):
    raise RequestError(code, message)

def path_of(value, root):
    if not isinstance(value, str) or '\0' in value:
        fail('INVALID_REQUEST', 'Invalid path')
    return os.path.realpath(os.path.join(root, value))

def data_of(path, maximum=FILE_MAX):
    with open(path, 'rb') as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        fail('TOO_LARGE', 'File exceeds size limit')
    return data

def digest(data):
    return hashlib.sha256(data).hexdigest()

def atomic_write(path, content, expected=None):
    data = content.encode('utf-8')
    if len(data) > FILE_MAX:
        fail('TOO_LARGE', 'File exceeds size limit')
    # Verify immediately before publication too. This is an optimistic guard,
    # not a cross-process lock against unrelated writers.
    def check():
        if expected == 'missing':
            if os.path.lexists(path):
                fail('STALE_VERSION', 'File appeared since it was observed missing')
        elif expected is not None:
            try:
                actual = digest(data_of(path))
            except FileNotFoundError:
                actual = None
            if actual != expected:
                fail('STALE_VERSION', 'File changed since it was read')
    check()
    fd, temporary = tempfile.mkstemp(prefix='.dsh-write-', dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if os.path.exists(path):
            os.chmod(temporary, os.stat(path).st_mode & 0o777)
        check()
        if expected == 'missing':
            try:
                os.link(temporary, path)
            except FileExistsError:
                fail('STALE_VERSION', 'File appeared since it was observed missing')
        else:
            os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {'path': path, 'version': digest(data), 'bytes': len(data)}

def terminate(process):
    try:
        if os.name == 'posix':
            os.killpg(process.pid, signal.SIGTERM)
        elif process.poll() is None:
            process.terminate()
    except ProcessLookupError:
        return
    time.sleep(0.15)
    try:
        if os.name == 'posix':
            os.killpg(process.pid, signal.SIGKILL)
        elif process.poll() is None:
            process.kill()
    except ProcessLookupError:
        pass
    process.wait()

def run_command(arg, root):
    command = arg.get('command')
    if not isinstance(command, str) or '\0' in command:
        fail('INVALID_REQUEST', 'Invalid command')
    timeout = arg.get('timeout_ms', 60000)
    if type(timeout) is not int or not 1 <= timeout <= 600000:
        fail('INVALID_REQUEST', 'Invalid command timeout')
    cwd = path_of(arg.get('cwd', '.'), root)
    if cancelled.is_set():
        fail('ABORTED', 'Remote operation cancelled')
    process = subprocess.Popen(['/bin/bash', '-lc', command], cwd=cwd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    output = [bytearray(), bytearray()]
    truncated = [False]
    lock = threading.Lock()
    def collect(stream, index):
        try:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    break
                with lock:
                    remaining = max(0, OUTPUT_MAX - len(output[0]) - len(output[1]))
                    output[index].extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        truncated[0] = True
        finally:
            stream.close()
    readers = [threading.Thread(target=collect, args=(stream, i), daemon=True)
               for i, stream in enumerate((process.stdout, process.stderr))]
    for thread in readers:
        thread.start()
    deadline = time.monotonic() + timeout / 1000
    timed_out = False
    try:
        while True:
            if cancelled.is_set() or time.monotonic() >= deadline:
                timed_out = not cancelled.is_set()
                terminate(process)
                break
            if process.poll() is not None and not any(t.is_alive() for t in readers):
                break
            time.sleep(0.02)
    finally:
        # Root exit does not authorize leaving descendants behind.
        terminate(process)
        for thread in readers:
            thread.join(timeout=2)
    if cancelled.is_set():
        fail('ABORTED', 'Remote operation cancelled')
    return {'stdout': output[0].decode('utf-8', 'replace'), 'stderr': output[1].decode('utf-8', 'replace'),
            'exitCode': process.returncode, 'timedOut': timed_out, 'truncated': truncated[0], 'cwd': cwd}

def sidebar_check():
    if cancelled.is_set():
        fail('ABORTED', 'Remote operation cancelled')

def sidebar_excludes(arg, root):
    patterns = arg.get('exclude', [])
    if patterns is None:
        patterns = []
    if not isinstance(patterns, list) or len(patterns) > 256 or any(not isinstance(p, str) or len(p) > 4096 for p in patterns):
        fail('INVALID_REQUEST', 'Invalid exclude patterns')
    def excluded(path):
        relative = os.path.relpath(path, root).replace(os.sep, '/')
        for pattern in patterns:
            pattern = pattern.replace('\\', '/').strip('/')
            variants = [pattern]
            if pattern.startswith('**/'):
                variants.append(pattern[3:])
            for candidate in variants:
                if fnmatch.fnmatchcase(relative, candidate):
                    return True
                if candidate.endswith('/**') and fnmatch.fnmatchcase(relative, candidate[:-3]):
                    return True
                if '/' not in candidate and fnmatch.fnmatchcase(os.path.basename(path), candidate):
                    return True
        return False
    return excluded

def sidebar_file_info(path):
    info = os.stat(path)
    if not stat.S_ISREG(info.st_mode):
        fail('INVALID_REQUEST', 'Remote path is not a regular file')
    return info

def sidebar_stat(path):
    info = os.stat(path)
    return {'path': path, 'size': info.st_size, 'mtimeMs': info.st_mtime_ns / 1000000,
            'isDir': stat.S_ISDIR(info.st_mode), 'isFile': stat.S_ISREG(info.st_mode),
            'fingerprint': digest(('%s:%s:%s:%s' % (info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)).encode())}

def sidebar_tree(path, root, arg):
    excluded = sidebar_excludes(arg, root)
    rows, truncated, scanned = [], False, 0
    with os.scandir(path) as iterator:
        for item in iterator:
            sidebar_check()
            scanned += 1
            if scanned > 100000:
                truncated = True
                break
            if excluded(item.path):
                continue
            if len(rows) >= 1000:
                truncated = True
                break
            link, broken = item.is_symlink(), False
            try:
                info = item.stat(follow_symlinks=True)
                directory = item.is_dir(follow_symlinks=True)
                metadata = {'size': info.st_size, 'mtimeMs': info.st_mtime_ns / 1000000}
                stamp = [info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns]
            except OSError:
                broken, directory, metadata, stamp = link, False, {}, []
            rows.append(({'name': item.name, 'path': os.path.join(path, item.name), 'isDir': directory,
                          'hidden': item.name.startswith('.'), 'isSymlink': link, 'broken': broken, **metadata}, stamp))
    rows.sort(key=lambda pair: (not pair[0]['isDir'], pair[0]['name'].lower(), pair[0]['name']))
    directory_info = os.stat(path)
    fingerprint = digest(json.dumps([rows, directory_info.st_mtime_ns, directory_info.st_ctime_ns], sort_keys=True, ensure_ascii=False).encode('utf-8'))
    return {'path': path, 'entries': [row for row, _ in rows], 'truncated': truncated, 'fingerprint': fingerprint}

def sidebar_read(path):
    sidebar_check()
    info = sidebar_file_info(path)
    with open(path, 'rb') as stream:
        head = stream.read(4096)
        common = {'size': info.st_size, 'mtimeMs': info.st_mtime_ns / 1000000}
        if b'\0' in head:
            return {'kind': 'binary', 'head': base64.b64encode(head).decode('ascii'), **common}
        if info.st_size > 1024 * 1024:
            return {'kind': 'too-large', 'head': base64.b64encode(head).decode('ascii'), **common}
        data = head + stream.read(1024 * 1024 + 1 - len(head))
    sidebar_check()
    if len(data) > 1024 * 1024:
        return {'kind': 'too-large', 'head': base64.b64encode(head).decode('ascii'), **common}
    try:
        if b'\0' in data:
            raise UnicodeError()
        return {'kind': 'text', 'content': data.decode('utf-8-sig'), **common}
    except UnicodeError:
        return {'kind': 'binary', 'head': base64.b64encode(head).decode('ascii'), **common}

def sidebar_read_page(path, arg):
    offset = arg.get('offset', 0)
    if type(offset) is not int or offset < 0:
        fail('INVALID_REQUEST', 'Invalid byte offset')
    info = sidebar_file_info(path)
    offset = min(offset, info.st_size)
    with open(path, 'rb') as stream:
        head = stream.read(4096)
        if b'\0' in head:
            return {'kind': 'binary', 'size': info.st_size, 'mtimeMs': info.st_mtime_ns / 1000000,
                    'head': base64.b64encode(head).decode('ascii')}
        stream.seek(offset)
        data = stream.read(256 * 1024)
    sidebar_check()
    if offset + len(data) < info.st_size:
        end = data.rfind(b'\n')
        if end >= 0:
            data = data[:end + 1]
        else:
            # Overlong lines are split at a UTF-8 boundary to guarantee progress.
            for trim in range(4):
                candidate = data[:-trim] if trim else data
                try:
                    candidate.decode('utf-8')
                    data = candidate
                    break
                except UnicodeDecodeError:
                    continue
    return {'kind': 'text', 'text': data.decode('utf-8', 'replace'), 'offset': offset,
            'nextOffset': offset + len(data), 'eof': offset + len(data) >= info.st_size,
            'size': info.st_size, 'mtimeMs': info.st_mtime_ns / 1000000, 'encoding': 'utf-8'}

def sidebar_read_binary_page(path, arg):
    offset, limit = arg.get('offset', 0), arg.get('limit', 1024 * 1024)
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 1024 * 1024:
        fail('INVALID_REQUEST', 'Invalid binary byte window')
    sidebar_check()
    sidebar_file_info(path)
    with open(path, 'rb') as stream:
        info = os.fstat(stream.fileno())
        mtime = info.st_mtime_ns / 1000000
        if (arg.get('expectedMtimeMs') is not None and arg['expectedMtimeMs'] != mtime
                or arg.get('expectedSize') is not None and arg['expectedSize'] != info.st_size):
            fail('STALE_VERSION', 'File changed since it was statted')
        offset = min(offset, info.st_size)
        stream.seek(offset)
        data = stream.read(limit)
        after = os.fstat(stream.fileno())
        if after.st_size != info.st_size or after.st_mtime_ns != info.st_mtime_ns:
            fail('STALE_VERSION', 'File changed while reading')
    sidebar_check()
    return {'data': base64.b64encode(data).decode('ascii'), 'offset': offset,
            'nextOffset': offset + len(data), 'eof': offset + len(data) >= info.st_size,
            'size': info.st_size, 'mtimeMs': mtime}

def sidebar_search(root, arg):
    query = arg.get('query')
    if not isinstance(query, str) or not query or len(query) > 4096 or '\0' in query:
        fail('INVALID_REQUEST', 'Invalid search query')
    excluded = sidebar_excludes(arg, root)
    matches, directories, scanned, truncated = [], [], 0, False
    if os.path.isabs(query) or query.startswith(('./', '../', '~/')) or query == '~':
        target = path_of(os.path.expanduser(query), root)
        if os.path.exists(target):
            matches.append(target)
            if os.path.isdir(target):
                directories.append(target)
        return {'matches': matches, 'dirs': directories, 'truncated': False}
    needle = query.lower().replace('\\', '/')
    for directory, dirs, files in os.walk(root, followlinks=False):
        sidebar_check()
        dirs.sort()
        files.sort()
        dirs[:] = [name for name in dirs if not excluded(os.path.join(directory, name))]
        for name in dirs + files:
            sidebar_check()
            scanned += 1
            if scanned > 100000:
                truncated = True
                break
            candidate = os.path.join(directory, name)
            if excluded(candidate):
                continue
            relative = os.path.relpath(candidate, root).replace(os.sep, '/')
            if needle not in (relative if '/' in needle else name).lower():
                continue
            if len(matches) >= 500:
                truncated = True
                break
            matches.append(candidate)
            if name in dirs:
                directories.append(candidate)
        if truncated:
            break
    return {'matches': matches, 'dirs': directories, 'truncated': truncated}

def dispatch(request):
    root = path_of(request.get('root'), os.getcwd())
    arg = request.get('input', {})
    if not isinstance(arg, dict):
        fail('INVALID_REQUEST', 'Input must be an object')
    action = request.get('action')
    if action != 'exec':
        root = path_of(arg.get('cwd', '.'), root)
    if action == 'probe':
        if not os.path.isdir(root):
            fail('NOT_DIRECTORY', 'Workspace is not a directory')
        return {'hostname': socket.gethostname(), 'platform': platform.system(), 'python': platform.python_version(), 'root': root}
    if action == 'exec':
        return run_command(arg, root)
    if action == 'sidebar_watch_snapshot':
        paths = arg.get('paths')
        if not isinstance(paths, list) or not 1 <= len(paths) <= 64 or any(not isinstance(p, str) or not os.path.isabs(p) or '\0' in p for p in paths):
            fail('INVALID_REQUEST', 'Invalid watch paths (1 to 64 absolute paths required)')
        levels = []
        for directory in paths:
            sidebar_check()
            try:
                listing = sidebar_tree(directory, root, arg)
                levels.append({'dir': directory, 'fingerprint': listing['fingerprint']})
            except OSError as error:
                levels.append({'dir': directory, 'fingerprint': None, 'error': type(error).__name__})
        return {'levels': levels}
    if action == 'sidebar_search':
        return sidebar_search(root, arg)
    # Keep directory entry paths lexical so symlinks retain their own row identity.
    if action == 'sidebar_tree':
        target = arg.get('path', '.')
        if not isinstance(target, str) or '\0' in target:
            fail('INVALID_REQUEST', 'Invalid path')
        return sidebar_tree(os.path.abspath(os.path.join(root, os.path.expanduser(target))), root, arg)
    path = path_of(arg.get('path', '.'), root)
    if action == 'sidebar_stat':
        sidebar_check()
        return sidebar_stat(path)
    if action == 'sidebar_read':
        return sidebar_read(path)
    if action == 'sidebar_read_binary_page':
        return sidebar_read_binary_page(path, arg)
    if action == 'sidebar_read_page':
        return sidebar_read_page(path, arg)
    if action in ('list', 'glob', 'grep'):
        limit = arg.get('limit', 250 if action == 'grep' else 1000)
        if type(limit) is not int or not 1 <= limit <= 2000:
            fail('INVALID_REQUEST', 'Invalid result limit')
        limit = min(limit, 250 if action == 'grep' else 1000)
    if action == 'read':
        data = data_of(path)
        lines = data.decode('utf-8').splitlines()
        offset, limit = arg.get('offset', 1), arg.get('limit', 200)
        if not isinstance(offset, int) or offset < 1 or not isinstance(limit, int) or not 1 <= limit <= 10000:
            fail('INVALID_REQUEST', 'Invalid line window')
        return {'path': path, 'lines': [{'number': n + 1, 'text': lines[n]} for n in range(offset - 1, min(len(lines), offset - 1 + limit))],
                'totalLines': len(lines), 'version': digest(data)}
    if action == 'read_binary':
        data = data_of(path, 10 * 1024 * 1024)
        return {'path': path, 'data': base64.b64encode(data).decode('ascii'), 'mediaType': mimetypes.guess_type(path)[0] or 'application/octet-stream', 'bytes': len(data)}
    if action == 'write':
        if not isinstance(arg.get('content'), str):
            fail('INVALID_REQUEST', 'Content must be text')
        return atomic_write(path, arg['content'], arg.get('expectedVersion'))
    if action == 'edit':
        if not isinstance(arg.get('expectedVersion'), str):
            fail('VERSION_REQUIRED', 'Read the file before editing')
        original = data_of(path).decode('utf-8')
        old, new = arg.get('old'), arg.get('new')
        if not isinstance(old, str) or not old or not isinstance(new, str):
            fail('INVALID_REQUEST', 'Invalid edit strings')
        if digest(original.encode('utf-8')) != arg['expectedVersion']:
            fail('STALE_VERSION', 'File changed since it was read')
        count = original.count(old)
        if count == 0:
            fail('EDIT_NOT_FOUND', 'Edit text was not found')
        if count != 1 and not arg.get('replaceAll', False):
            fail('AMBIGUOUS_EDIT', 'Edit text has multiple matches')
        return atomic_write(path, original.replace(old, new, -1 if arg.get('replaceAll') else 1), arg['expectedVersion'])
    if action == 'list':
        entries, truncated = [], False
        with os.scandir(path) as iterator:
            for item in iterator:
                if len(entries) >= limit:
                    truncated = True
                    break
                kind = 'symlink' if item.is_symlink() else 'directory' if item.is_dir(follow_symlinks=False) else 'file' if item.is_file(follow_symlinks=False) else 'other'
                entries.append({'name': item.name, 'path': os.path.join(path, item.name), 'type': kind})
        return {'path': path, 'entries': sorted(entries, key=lambda x: x['name']), 'truncated': truncated}
    if action not in ('glob', 'grep'):
        fail('INVALID_ACTION', 'Unsupported remote action')
    pattern = arg.get('pattern')
    if not isinstance(pattern, str) or len(pattern) > 4096:
        fail('INVALID_REQUEST', 'Invalid search pattern')
    regex = re.compile(pattern) if action == 'grep' else None
    include = arg.get('include')
    if include is not None and not isinstance(include, str):
        fail('INVALID_REQUEST', 'Invalid include pattern')
    paths, files, matches, scanned, truncated = [], [], 0, 0, False
    def candidates():
        if os.path.isfile(path):
            yield path
        else:
            for directory, dirs, names in os.walk(path, followlinks=False):
                dirs.sort()
                for name in sorted(names):
                    yield os.path.join(directory, name)
    for candidate in candidates():
        if cancelled.is_set():
            fail('ABORTED', 'Remote operation cancelled')
        scanned += 1
        if scanned > 100000:
            truncated = True
            break
        relative = os.path.relpath(candidate, path).replace(os.sep, '/') if candidate != path else os.path.basename(path)
        if action == 'glob':
            if fnmatch.fnmatch(relative if '/' in pattern else os.path.basename(candidate), pattern) or (pattern.startswith('**/') and fnmatch.fnmatch(relative, pattern[3:])):
                if len(paths) >= limit:
                    truncated = True
                    break
                paths.append(candidate)
        else:
            if include and not fnmatch.fnmatch(relative if '/' in include else os.path.basename(candidate), include):
                continue
            try:
                text = data_of(candidate).decode('utf-8')
            except (OSError, UnicodeError, RequestError):
                continue
            found = []
            for number, line in enumerate(text.splitlines(), 1):
                if regex.search(line):
                    if matches >= limit:
                        truncated = True
                        break
                    # Bound giant single-line search results too.
                    found.append({'lineNumber': number, 'line': line[:4096]})
                    truncated = truncated or len(line) > 4096
                    matches += 1
            if found:
                files.append({'path': candidate, 'matches': found})
            if matches >= limit:
                truncated = True
                break
    return {'paths': paths, 'truncated': truncated} if action == 'glob' else {'files': files, 'truncated': truncated}

def main():
    try:
        raw = sys.stdin.buffer.readline(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024 or not raw.endswith(b'\n'):
            fail('INVALID_REQUEST', 'Invalid request frame')
        request = json.loads(raw)
        if not isinstance(request, dict):
            fail('INVALID_REQUEST', 'Request must be an object')
        def monitor():
            while sys.stdin.buffer.read(1):
                pass
            cancelled.set()
        threading.Thread(target=monitor, daemon=True).start()
        signal.signal(signal.SIGTERM, lambda *_: cancelled.set())
        result = {'ok': True, 'result': dispatch(request)}
    except RequestError as exc:
        result = {'ok': False, 'error': {'code': exc.code, 'message': exc.message}}
    except FileNotFoundError:
        result = {'ok': False, 'error': {'code': 'NOT_FOUND', 'message': 'Remote path or executable was not found'}}
    except PermissionError:
        result = {'ok': False, 'error': {'code': 'PERMISSION_DENIED', 'message': 'Remote permission denied'}}
    except (ValueError, TypeError, UnicodeError, re.error):
        result = {'ok': False, 'error': {'code': 'INVALID_REQUEST', 'message': 'Invalid remote request or text encoding'}}
    except Exception:
        result = {'ok': False, 'error': {'code': 'IO_ERROR', 'message': 'Remote operation failed'}}
    # ASCII escaping keeps JSON portable; byte cap allows the 10 MiB binary action.
    encoded = json.dumps(result, ensure_ascii=False).encode('utf-8')
    if len(encoded) > 16 * 1024 * 1024:
        encoded = b'{"ok":false,"error":{"code":"TOO_LARGE","message":"Response exceeds size limit"}}'
    sys.stdout.buffer.write(encoded + b'\n')
    sys.stdout.buffer.flush()
    # A daemon blocked in stdin must not race CPython buffered-stream shutdown.
    os._exit(0)

if __name__ == '__main__':
    main()
