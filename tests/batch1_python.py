"""Offline quota contract test: standard library only; provider and database are mocked."""
import contextlib
import importlib
import json
import os
from pathlib import Path
import sys
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'knowledge'))
sys.modules['httpx'] = types.ModuleType('httpx')
sys.modules['kb.db'] = types.ModuleType('kb.db')
gemini = importlib.import_module('kb.video.gemini')


class QuotaTest(unittest.TestCase):
    def test_shared_defaults_and_empty_override(self):
        with patch.dict(os.environ, {'LLM_DAILY_LIMITS': ''}):
            self.assertEqual(gemini._pairs(gemini.DEFAULT_LIMITS), {
                'gemini-3.1-flash-lite': '500', 'gemini-3-flash': '20',
                'gemini-2.5-flash-lite': '20', 'gemini-4-hydrogen': '20'})
            self.assertEqual(gemini.budget_key('models/gemini-3-flash-preview'), 'gemini-3-flash')
            self.assertEqual(gemini.budget_key('gemini-4-hydrogen-high'), 'gemini-4-hydrogen')
            self.assertIsNone(gemini.budget_key('gemma-4-31b-it'))

    def test_unavailable_accounting_sends_no_http(self):
        def unavailable():
            raise RuntimeError('DB unavailable')
        with patch.dict(os.environ, {'GEMINI_API_KEY': 'mock', 'LLM_DAILY_LIMITS': ''}):
            with patch.object(gemini.db, 'tx', unavailable, create=True):
                with patch.object(gemini.httpx, 'post', side_effect=AssertionError('HTTP forbidden'), create=True) as http:
                    with self.assertRaises(gemini.BudgetExhausted):
                        gemini.generate_json(['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'], 'kb_video', [], 'system')
                    self.assertEqual(http.call_count, 0)

    def test_atomic_concurrent_attempts_and_restart(self):
        lock = threading.Lock()
        rows = {}
        locks = []
        class Conn:
            def execute(self, sql, args):
                if 'pg_advisory_xact_lock' in sql:
                    locks.append(args[0])
                if sql.startswith('SELECT purpose'):
                    day, model = args
                    self.result = [{'purpose': p, 'used': used} for (d, m, p), used in rows.items() if d == day and m == model]
                if sql.startswith('INSERT'):
                    rows[args] = rows.get(args, 0) + 1
                return self
            def fetchall(self):
                return self.result
        @contextlib.contextmanager
        def tx():
            with lock:
                yield Conn()
        with patch.dict(os.environ, {'LLM_DAILY_LIMITS': 'gemini-3-flash=20', 'LLM_BUDGET_RESERVED': 'gemini-3-flash=kb_review:5'}):
            with patch.object(gemini.db, 'tx', tx, create=True):
                with ThreadPoolExecutor(8) as pool:
                    self.assertEqual(sum(pool.map(lambda _: gemini.reserve('gemini-3-flash', 'caption'), range(40))), 15)
                self.assertEqual(sum(gemini.reserve('gemini-3-flash', 'kb_review') for _ in range(20)), 5)
                # Re-importing the client cannot clear the durable quota rows.
                importlib.reload(gemini)
                self.assertFalse(gemini.reserve('gemini-3-flash', 'kb_review'))
                self.assertTrue(all(k.startswith('llm:') and k.endswith(':gemini-3-flash') for k in locks))


if __name__ == '__main__':
    unittest.main()
