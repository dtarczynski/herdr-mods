import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1]/'mods/ai-limits/usage.py'
spec = importlib.util.spec_from_file_location('usage', PATH)
usage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usage)

class UsageTests(unittest.TestCase):
    def test_percent_bounds(self):
        for value in (None, True, '30', -1, 101, float('nan'), float('inf')):
            self.assertIsNone(usage.window('test', value, None))
        self.assertEqual(usage.window('test', 0, None)['used'], 0)
        self.assertEqual(usage.window('test', 100, None)['used'], 100)

    def test_removed_gemini_provider_is_not_queried(self):
        result=subprocess.run([sys.executable,str(PATH),'Gemini'],capture_output=True,text=True,check=True)
        self.assertEqual(json.loads(result.stdout)['providers'],[])

    def test_antigravity_groups_are_separate_and_disabled_skipped(self):
        report={'status':'SUCCESS','command':{'name':'usage','data':{'groups':[
            {'display_name':'Gemini Models','buckets':[
                {'bucket_id':'week','display_name':'7 days','remaining_fraction':.7},
                {'bucket_id':'disabled','remaining_fraction':0,'disabled':True}]},
            {'displayName':'Claude and GPT','buckets':[
                {'bucketId':'session','displayName':'5 hours','remaining':{'case':'remainingFraction','value':0}},
                {'bucketId':'missing'}]}]}}}
        rows=usage.antigravity_windows(report)
        self.assertEqual([r['used'] for r in rows],[30,100])
        self.assertEqual(rows[0]['label'],'Gemini Models · 7 days')
        self.assertEqual(rows[1]['label'],'Claude and GPT · 5 hours')
        report['status']='ERROR'
        self.assertEqual(usage.antigravity_windows(report),[])

    def test_invalid_fraction_is_not_zero(self):
        for value in (None, -0.1, 1.1, True, float('nan'), '0.5'):
            self.assertIsNone(usage.fraction_window('quota',value,None))

    def test_no_provider_arguments_do_not_read_accounts(self):
        result=subprocess.run([sys.executable,str(PATH)],capture_output=True,text=True,check=True)
        self.assertEqual(json.loads(result.stdout)['providers'],[])

    def test_invalid_override_does_not_fall_back(self):
        with patch.dict(os.environ,{'ANTIGRAVITY_CLI_PATH':''}), patch.object(usage.shutil,'which',return_value='/any/agy'):
            self.assertIsNone(usage.antigravity_binary())

    def test_errors_do_not_leak_provider_details(self):
        def fail(): raise RuntimeError('secret-auth-token')
        self.assertEqual(usage.read(('Test',fail)),{'name':'Test','error':'Usage unavailable'})

    @unittest.skipUnless(os.name=='posix','POSIX probe')
    def test_probe_timeout_and_output_limit(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(TimeoutError):
                usage.bounded_command([sys.executable,'-c','import time; time.sleep(2)'],os.environ,folder,.1)
            with self.assertRaises(ValueError):
                usage.bounded_command([sys.executable,'-c','print("x"*1100000)'],os.environ,folder,2)
            self.assertEqual(usage.bounded_command([sys.executable,'-c','print("ok")'],os.environ,folder,2).strip(),'ok')

if __name__=='__main__': unittest.main()
