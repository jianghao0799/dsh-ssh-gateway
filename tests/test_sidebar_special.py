import os
from pathlib import Path
import runpy
import tempfile
import unittest

HELPER = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'remote-helper.py'))


class SidebarSpecialFiles(unittest.TestCase):
    @unittest.skipUnless(hasattr(os, 'mkfifo'), 'requires POSIX named pipes')
    def test_named_pipe_is_rejected_without_waiting_for_a_writer(self):
        with tempfile.TemporaryDirectory(prefix='sidebar-pipe-') as root:
            path = os.path.join(root, 'pipe')
            os.mkfifo(path)
            self.assertFalse(HELPER['sidebar_stat'](path)['isFile'])
            for name in ['sidebar_read', 'sidebar_read_page', 'sidebar_read_binary_page']:
                with self.subTest(operation=name):
                    with self.assertRaises(HELPER['RequestError']) as raised:
                        if name == 'sidebar_read':
                            HELPER[name](path)
                        else:
                            HELPER[name](path, {})
                    self.assertEqual(raised.exception.code, 'INVALID_REQUEST')


if __name__ == '__main__':
    unittest.main()
