import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('installer',Path(__file__).resolve().parents[1]/'install.py')
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)

class InstallerTests(unittest.TestCase):
    def source(self):
        return {'id':'root','children':[
            {'id':'tabs','content':{'mod':'tabs'}},
            {'id':'panel-body','type':'stack','children':[{'id':'files'}]},
            {'id':'sidebar-lists','type':'column','children':[{'id':'agents','content':{'mod':'agents'},'size':{'px':180}}]}]}
    def test_sequential_packages_preserve_source_and_other_blocks(self):
        source=self.source(); original=repr(source); changed=source
        for name in installer.PACKAGES:
            changed=installer.patch_layout(changed,name)
        self.assertEqual(repr(source),original)
        self.assertEqual(installer.find(changed,'agents')['size'],{'px':180})
        self.assertEqual(installer.find(changed,'agents')['content']['mod'],'agents-context')
        self.assertIsNotNone(installer.find(changed,'files'))
        self.assertIsNotNone(installer.find(changed,'github-issues'))
        self.assertIsNotNone(installer.find(changed,'ai-limits'))
    def test_custom_mod_and_duplicate_nodes_are_rejected(self):
        source=self.source(); source['children'][0]['content']['mod']='my-tabs'
        with self.assertRaises(ValueError): installer.patch_layout(source,'github-issues')
        source=installer.patch_layout(self.source(),'ai-limits')
        with self.assertRaises(ValueError): installer.patch_layout(source,'ai-limits')
    def test_missing_layout_structure_is_rejected(self):
        for name in installer.PACKAGES:
            with self.assertRaises(ValueError): installer.patch_layout({},name)
