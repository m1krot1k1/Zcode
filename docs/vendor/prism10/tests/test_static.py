import sys,re,json,unittest
from pathlib import Path
R=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(R/'scripts'))
from compile_prompt import compile_profile
FULL=(R/'PRISM_INFINITY_10.0_FULL_MASTER_RU.md').read_text(encoding='utf-8')
BASE=R/'legacy/PRISM_INFINITY_9.0_FULL_Master_RU.md'
class TestStructure(unittest.TestCase):
 def test_version(self):
  self.assertIn('**Версия:** PRISM ∞ 10.0 FULL',FULL)
 def test_one_activation(self):
  self.assertEqual(FULL.count('PRISM ∞ 10.0 активирован.'),1)
  self.assertNotIn('PRISM ∞ 9.0 активирован.',FULL)
 def test_compiles_profiles(self):
  for profile in ['fast','research','coding','swarm','evolution','discovery','all','full']:
   with self.subTest(profile=profile):
    t=compile_profile(profile)
    self.assertEqual(t.count('PRISM ∞ 10.0 активирован.'),1)
    self.assertEqual(t.count('```')%2,0)
 def test_full_has_all_inherited_sections(self):
  if not BASE.exists(): self.skipTest('9.0 source not mounted outside release zip')
  old=BASE.read_text(encoding='utf-8')
  def get_sections(t):
   m=list(re.finditer(r'^## .+$',t,re.M))
   return {x.group(0):t[x.start():m[i+1].start() if i+1<len(m) else len(t)] for i,x in enumerate(m)}
  a,b=get_sections(old),get_sections(FULL)
  for header,body in a.items():
   if header=='## 11. Правила поставки и общения': continue
   if header=='## ПРИЛОЖЕНИЕ I — СТАТУС PRISM 9.0 И ЧТО РЕАЛЬНО ПРОВЕРЕНО': continue
   # Sections 10AX through previous body are required to be text-identical.
   if re.match(r'^## (?:[2-9]|10[A-Z]{0,2})\.',header):
    with self.subTest(header=header):self.assertIn(body,FULL)
 def test_new_mechanisms(self):
  for code in ['10AY','10AZ','10BA','10BB','10BC','10BD','10BE','10BF','10BG','10BH','10BI','10BJ']:
   self.assertRegex(FULL,rf'(?m)^## {code}\. ')
 def test_profiles_smaller(self):
  for p in ['fast','swarm','discovery']:
   self.assertLess(len(compile_profile(p)),len(FULL)/5)
 def test_manifest(self):
  m=json.loads((R/'manifest.json').read_text())
  for mod in m['modules'].values():self.assertTrue((R/mod['path']).exists())
 def test_only_one_active_core(self):
  t=(R/'PRISM_10.0_CORE_RU.md').read_text()
  self.assertEqual(t.count('PRISM ∞ 10.0 активирован.'),1)
  self.assertIn('не имитируй его',t)
if __name__=='__main__':unittest.main(verbosity=2)
