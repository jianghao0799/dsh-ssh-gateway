import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('remote_helper', pathlib.Path(__file__).resolve().parents[1] / 'remote-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

class RemoteHelperTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = self.temporary.name
        helper.cancelled.clear()
    def tearDown(self):
        self.temporary.cleanup()
    def request(self, action, **values):
        return helper.dispatch({'root': self.root, 'action': action, 'input': values})
    def test_missing_creates_but_never_overwrites(self):
        created = self.request('write', path='new.txt', content='first', expectedVersion='missing')
        self.assertEqual(created['bytes'], 5)
        with self.assertRaises(helper.RequestError) as error:
            self.request('write', path='new.txt', content='overwrite', expectedVersion='missing')
        self.assertEqual(error.exception.code, 'STALE_VERSION')
        self.assertEqual(self.request('read', path='new.txt')['lines'][0]['text'], 'first')
        real_link = os.link
        def race(source, destination):
            with open(destination, 'x', encoding='utf-8') as stream:
                stream.write('concurrent writer')
            return real_link(source, destination)
        with mock.patch.object(helper.os, 'link', side_effect=race):
            with self.assertRaises(helper.RequestError) as error:
                self.request('write', path='race.txt', content='must not win', expectedVersion='missing')
        self.assertEqual(error.exception.code, 'STALE_VERSION')
        self.assertEqual(self.request('read', path='race.txt')['lines'][0]['text'], 'concurrent writer')
        self.assertFalse(any(name.startswith('.dsh-write-') for name in os.listdir(self.root)))
    def test_result_limits_are_applied_and_validated(self):
        for name in ('a.txt', 'b.txt', 'c.txt'):
            self.request('write', path=name, content='match\n' * 4)
        for action, values, key in (('list', {}, 'entries'), ('glob', {'pattern': '*.txt'}, 'paths')):
            result = self.request(action, limit=2, **values)
            self.assertEqual(len(result[key]), 2)
            self.assertTrue(result['truncated'])
        result = self.request('grep', pattern='match', limit=2)
        self.assertEqual(sum(len(item['matches']) for item in result['files']), 2)
        self.assertTrue(result['truncated'])
        for action in ('list', 'glob', 'grep'):
            for limit in (0, 2001, True, 1.5):
                with self.assertRaises(helper.RequestError) as error:
                    self.request(action, pattern='*', limit=limit)
                self.assertEqual(error.exception.code, 'INVALID_REQUEST')
        with self.assertRaises(helper.RequestError):
            self.request('exec', command='ignored', timeout_ms=600001)
    def test_atomic_stale_edit_and_line_window(self):
        written = self.request('write', path='a.txt', content='one\ntwo\n')
        read = self.request('read', path='a.txt', offset=2, limit=1)
        self.assertEqual(read['lines'], [{'number': 2, 'text': 'two'}])
        self.assertEqual(read['version'], written['version'])
        with self.assertRaises(helper.RequestError) as error:
            self.request('write', path='a.txt', content='lost', expectedVersion='stale')
        self.assertEqual(error.exception.code, 'STALE_VERSION')
        self.assertEqual(self.request('read', path='a.txt')['version'], written['version'])
        with self.assertRaises(helper.RequestError):
            self.request('edit', path='a.txt', old='one', new='new')
        edited = self.request('edit', path='a.txt', old='one', new='new', expectedVersion=written['version'])
        self.assertNotEqual(edited['version'], written['version'])
        self.assertFalse(any(name.startswith('.dsh-write-') for name in os.listdir(self.root)))
    def test_limits_and_search(self):
        self.request('write', path='a.txt', content='hit\n' * 300)
        result = self.request('grep', pattern='hit', include='*.txt')
        self.assertEqual(len(result['files'][0]['matches']), 250)
        self.assertTrue(result['truncated'])
        self.assertEqual(len(self.request('glob', pattern='**/*.txt')['paths']), 1)
        self.assertEqual(self.request('list')['entries'][0]['name'], 'a.txt')
        with self.assertRaises(helper.RequestError):
            self.request('write', path='big', content='x' * (helper.FILE_MAX + 1))
    def test_session_cwd_is_used_by_file_actions(self):
        directory = os.path.join(self.root, 'session')
        os.mkdir(directory)
        self.request('write', path='a.txt', content='session data', cwd=directory)
        self.assertTrue(os.path.isfile(os.path.join(directory, 'a.txt')))
        self.assertEqual(self.request('read', path='a.txt', cwd=directory)['lines'][0]['text'], 'session data')
        paths = self.request('glob', pattern='*.txt', cwd=directory)['paths']
        self.assertEqual(len(paths), 1)
        self.assertTrue(os.path.samefile(paths[0], os.path.join(directory, 'a.txt')))
        self.assertEqual(self.request('list', cwd=directory)['entries'][0]['name'], 'a.txt')
        self.assertEqual(self.request('grep', pattern='session', cwd=directory)['files'][0]['matches'][0]['lineNumber'], 1)
    def test_ambiguous_and_binary(self):
        written = self.request('write', path='a.txt', content='repeat repeat')
        with self.assertRaises(helper.RequestError) as error:
            self.request('edit', path='a.txt', old='repeat', new='x', expectedVersion=written['version'])
        self.assertEqual(error.exception.code, 'AMBIGUOUS_EDIT')
        self.assertEqual(self.request('read_binary', path='a.txt')['bytes'], 13)
    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux Bash and process-group lifecycle')
    def test_exec_injection_output_limit_and_timeout(self):
        result = self.request('exec', command='printf \'{"ok":true}\'; printf error >&2')
        self.assertEqual(result['stdout'], '{"ok":true}')
        self.assertEqual(result['stderr'], 'error')
        self.assertTrue(self.request('exec', command='sleep 10', timeout_ms=50)['timedOut'])
        output = self.request('exec', command='head -c 2000000 /dev/zero')
        self.assertTrue(output['truncated'])
        self.assertLessEqual(len(output['stdout']), helper.OUTPUT_MAX)

if __name__ == '__main__':
    unittest.main()
