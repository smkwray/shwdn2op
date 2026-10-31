"""Independent target-loss arithmetic and causal trainer-input drift checks."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import zipfile

import torch
from soft_policy import capture_inputs, distillation_loss, input_digest, replay_sample


class SoftPolicyTests(unittest.TestCase):
    def test_generation_accepts_bound_native_qualification_and_keeps_every_gate(self):
        from export_candidate import BASE_SHA
        from soft_policy import training_plan
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            def write(name,value):
                path=root/(name+'.json');path.write_text(json.dumps(value))
                return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
            teacher='metamon:Ensemble:'+'c'*64;members=[BASE_SHA,'a'*64,'b'*64]
            rows=[{'model':'E3','sourcePile':0,'block':'production','battle_tag':str(i)} for i in range(20000)]
            manifest=write('manifest',{'kept':rows})
            audit=write('audit',{'complete':True,'teacher':teacher,'members':members,'inputMismatchFiles':0,
                'files':len(rows),'proof':{'manifestSha256':manifest['sha256']},'decisions':len(rows),
                'context':{'mode':'initial_prefix','maxDecisions':128,'includedDecisions':len(rows),'outsidePrefixExcluded':0}})
            cpu=write('cpu',{'pass':True,'commonCDFChoicesEqual':True,'decisions':150,'revivalInputs':10})
            config=write('config',{'policyId':teacher,'members':[{'sha256':s} for s in members]})
            scales=[{'block':'scale1','games':128,'workers':2},
                    {'block':'scale2','games':128,'workers':2},
                    {'block':'scale4','games':128,'workers':4,'resource_optional':True}]
            registration=write('registration',{'targetGamesPerHour':1000,'sustainedGames':512,
                'scales':scales,'mlxRevivalParity':{'sha256':cpu['sha256']}})
            def stage(name,games):
                return {'block':name,'requestedGames':games,'workers':2,'status':'PASS','returncode':0,
                    'lifecycle':{'reason':'completed','games':games,'elapsed_s':games*3.,'validation_clean':True,
                        'ownedProcessesAfter':0,'port8000ListeningAfter':False},'inputAudit':{'pass':True,'files':games}}
            stages=[stage('scale1',128),stage('scale2',128),{'block':'scale4','requestedGames':128,'workers':4,
                'status':'FAILED_RESOURCE_SCALE_RETAINED','lifecycle':{'reason':'memory_pressure',
                    'ownedProcessesAfter':0,'port8000ListeningAfter':False}},stage('sustain1',256),stage('sustain2',256)]
            qualification={'phase':'PASS','qualificationOnly':True,'trainingEligible':False,'targetGamesPerHour':1000,
                'sustainedGamesPerHour':1200.,'teacherReusedForwardCoverage':1,'selected':'twoActorAlternating','results':stages}
            replays={r['block']:write(r['block']+'-replay',{'pass':True,'games':r['requestedGames']})
                     for r in stages if r['status']=='PASS'}
            reference={**write('qualification',qualification),'native':{'registration':registration,
                'cpuReference':cpu,'teacherConfig':config,'replays':replays}}
            plan={'schema':'uu-soft-training@1','teacherName':'E3','teacherId':teacher,'members':members,
                'dataManifestSha256':manifest['sha256'],'anchorWeight':.1,'updates':4000,'finalEpoch':3,
                'context':{'mode':'initial_prefix','maxDecisions':128},'inputAudit':audit,
                'collectionQualification':reference,'minimumBattles':20000}
            def accept(value):
                path=write('plan',value)['path'];return training_plan(path,manifest['path'],'generation')
            self.assertEqual(accept(plan),plan)
            for field,value in [('phase','HOLD_ENGINEERING_OR_RETRY_COVERAGE'),('sustainedGamesPerHour',999.),
                                ('teacherReusedForwardCoverage',0),('selected','unknown')]:
                bad=copy.deepcopy(plan);bad['collectionQualification'].update(write('qualification-bad',{**qualification,field:value}))
                with self.subTest(field=field),self.assertRaisesRegex(ValueError,'Qualified teacher'):
                    accept(bad)
            for index,change in [(0,{'status':'FAILED_RETAINED'}),(2,{'status':'FAILED_RETAINED'}),
                                 (3,{'returncode':1})]:
                changed=copy.deepcopy(qualification);changed['results'][index].update(change)
                bad=copy.deepcopy(plan);bad['collectionQualification'].update(write('qualification-bad',changed))
                with self.subTest(stage=index),self.assertRaisesRegex(ValueError,'Qualified teacher'):
                    accept(bad)
            bad=copy.deepcopy(plan);bad['minimumBattles']=20001
            with self.assertRaisesRegex(ValueError,'20000 frozen battles'):accept(bad)
            Path(replays['sustain1']['path']).write_text('{"pass":false}')
            with self.assertRaisesRegex(ValueError,'proof drift'):accept(plan)

    def test_relocated_teacher_assets_preserve_exact_frozen_members(self):
        from soft_policy import verify_teacher_assets
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);assets=[]
            for index in range(3):
                path=root/f"member-{index}.pt";path.write_bytes(f"weights-{index}".encode())
                assets.append({"path":str(path),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()})
            members=[{**row,"path":f"/unavailable/member-{index}.pt"} for index,row in enumerate(assets)]
            frozen=json.dumps(members)
            verify_teacher_assets(members,list(reversed(assets)))
            self.assertEqual(json.dumps(members),frozen)
            for invalid in (assets[:2],assets+[assets[0]],[assets[0]]*3):
                with self.assertRaisesRegex(ValueError,"identity mismatch"):
                    verify_teacher_assets(members,invalid)
            Path(assets[0]["path"]).write_bytes(b"drift")
            with self.assertRaisesRegex(ValueError,"weight drift"):
                verify_teacher_assets(members,assets)

    def test_teacher_bundle_roundtrip_preserves_bytes_and_fails_on_input_drift(self):
        from bundle_data import bundle,unpack,check_names
        import filter_families
        for names in (['../outside'],['/absolute'],['CON'],['a:stream'],['dir/file.'],
                      ['dir/file '],['a\\b'],['a\x01b'],['File','file']):
            with self.subTest(names=names),self.assertRaises(ValueError):check_names(names)
        digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);data=root/'data';directory=data/'pile-0/UUKakuna/metamon/gen9uu'
            directory.mkdir(parents=True)
            panel=root/'panel.json';panel.write_text(json.dumps({'collection':[{'family':'train'}],
                'progress':[{'family':'progress'}],'excludedCertificationFamilies':['dev']}))
            producer=data/'producer.py';producer.write_bytes(Path(filter_families.__file__).read_bytes())
            rows=[]
            for side in ('p1','p2'):
                path=directory/(side+'.json.lz4');path.write_bytes(('fixture-'+side).encode())
                Path(str(path)+'.meta').write_text(json.dumps({'player':side}))
                rows.append({'sourcePile':0,'file':path.name,'sha256':digest(path),
                             'family':'train','opponent_family':'train'})
            manifest=data/'manifest.json';manifest.write_text(json.dumps({'complete':True,
                'qualificationOnly':False,'panelSha256':digest(panel),'producerSha256':digest(producer),
                'sources':[{}],'trajectories':2,'battles':1,'kept':rows}))
            audit=root/'audit.json';audit.write_text(json.dumps({'complete':True,'inputMismatchFiles':0,
                'proof':{'manifestSha256':digest(manifest),'panelSha256':digest(panel)}}))
            archive=root/'data.zip';report=bundle(data,panel,audit,archive)
            self.assertEqual(report['archiveSha256'],digest(archive))
            restored=root/'restored'
            with zipfile.ZipFile(archive) as z:
                self.assertIsNone(z.testzip())
            materialized=unpack(archive,Path(str(archive)+'.json'),restored)
            self.assertEqual(materialized['trajectories'],2)
            self.assertEqual((restored/'data/manifest.json').read_bytes(),manifest.read_bytes())
            proof=filter_families.validate_training_data(restored/'data/manifest.json',restored/'panel.json',
                [restored/'data/pile-0/UUKakuna/metamon'])
            self.assertEqual(sum(proof['verifiedPOVs'].values()),2)
            wrong=root/'wrong-receipt.json';wrong.write_text(json.dumps({**report,'archiveSha256':'0'*64}))
            with self.assertRaisesRegex(ValueError,'archive hash/size'):
                unpack(archive,wrong,root/'bad-transfer')
            self.assertFalse((root/'bad-transfer').exists())
            with self.assertRaises(FileExistsError):bundle(data,panel,audit,archive)
            path=directory/rows[0]['file'];original=path.read_bytes();path.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'hash mismatch'):bundle(data,panel,audit,root/'drift.zip')
            self.assertFalse((root/'drift.zip').exists())
            path.write_bytes(original);Path(str(path)+'.meta').unlink()
            with self.assertRaisesRegex(ValueError,'Regular bundle input'):bundle(data,panel,audit,root/'missing.zip')
            self.assertFalse((root/'missing.zip').exists())

    def test_native_loader_preserves_the_teachers_initial_recurrent_context(self):
        from unittest.mock import patch
        from amago.loading import RLData
        from metamon.rl.metamon_to_amago import MetamonAMAGODataset
        from soft_policy import install_sampler
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);directory=root/'pile-0/UUKakuna/metamon'
            manifest=root/'manifest.json'
            manifest.write_text(json.dumps({'kept':[{'model':'E3','sourcePile':0,'file':'one.json.lz4'}]}))
            plan={'dataManifestSha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),
                  'teacherName':'E3','teacherId':'teacher','members':[],
                  'context':{'mode':'initial_prefix','maxDecisions':128}}
            sample=RLData(obs={'x':torch.arange(161).reshape(161,1)},
                rews=torch.zeros(160,1),dones=torch.zeros(160,1,dtype=torch.bool),
                actions=torch.nn.functional.one_hot(torch.zeros(160,dtype=torch.long),13).float(),
                time_idxs=torch.arange(161).reshape(161,1))
            records=[self.record() for _ in range(160)]
            original=MetamonAMAGODataset.sample_random_trajectory
            try:
                install_sampler(plan,manifest)
                wrapper=MetamonAMAGODataset(SimpleNamespace(dset_root=str(directory),max_seq_len=None))
                wrapper.configure(items_per_epoch=1,max_seq_len=128,padded_sampling='both',has_edit_rights=False)
                with patch('soft_policy.replay_sample',return_value=(sample,records,[i for i in range(160) if i!=5],[5])),patch(
                        'random.randrange',return_value=32):
                    result=wrapper[0]
                self.assertEqual(result.time_idxs[0].item(),0)
                self.assertEqual(result.time_idxs[-1].item(),128)
                self.assertEqual(len(result),128)
                self.assertEqual(result.obs['soft_valid'][5].item(),0)
            finally:
                MetamonAMAGODataset.sample_random_trajectory=original

    def test_training_cannot_silently_select_only_the_small_pilot_stratum(self):
        from export_candidate import BASE_SHA
        from soft_policy import training_plan
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);manifest=root/'manifest.json'
            rows=[{'model':'E3','sourcePile':i,'block':f'block{i}','battle_tag':'one'} for i in range(2)]
            manifest.write_text(json.dumps({'kept':rows}))
            manifest_sha=hashlib.sha256(manifest.read_bytes()).hexdigest()
            members=[BASE_SHA,'a'*64,'b'*64];teacher='metamon:Ensemble:'+'c'*64
            audit=root/'audit.json'
            proof={'complete':True,'teacher':teacher,'members':members,'inputMismatchFiles':0,'files':2,
                   'proof':{'manifestSha256':manifest_sha},'decisions':2,
                   'context':{'mode':'initial_prefix','maxDecisions':128,
                              'includedDecisions':2,'outsidePrefixExcluded':0}}
            audit.write_text(json.dumps(proof))
            plan={'schema':'uu-soft-training@1','teacherName':'E3','teacherId':teacher,'members':members,
                'dataManifestSha256':manifest_sha,'anchorWeight':.1,'updates':4000,'finalEpoch':3,
                'context':{'mode':'initial_prefix','maxDecisions':128},
                'inputAudit':{'path':str(audit),'sha256':hashlib.sha256(audit.read_bytes()).hexdigest()}}
            path=root/'plan.json';path.write_text(json.dumps(plan))
            directories=[root/f'pile-{i}/UUKakuna/metamon' for i in range(2)]
            self.assertEqual(training_plan(path,manifest,'qualification',directories),plan)
            with self.assertRaisesRegex(ValueError,'every qualified teacher stratum'):
                training_plan(path,manifest,'qualification',directories[:1])
            audit.write_text(json.dumps({**proof,'files':1}))
            plan['inputAudit']['sha256']=hashlib.sha256(audit.read_bytes()).hexdigest()
            path.write_text(json.dumps(plan))
            with self.assertRaisesRegex(ValueError,'exact-input teacher audit'):
                training_plan(path,manifest,'qualification',directories)

    def test_selected_production_actor_loss_changes_actor_and_encoder_but_not_critic(self):
        from soft_policy import install_actor, target_tensors
        class Actor(torch.nn.Linear):
            def forward(self,x,straight_from_obs):
                return SimpleNamespace(probs=super().forward(x).softmax(-1).unsqueeze(2))
        class Policy(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.tstep_encoder=torch.nn.Sequential(torch.nn.Linear(1,2,bias=False),torch.nn.Dropout(1.))
                self.traj_encoder=torch.nn.Identity()
                self.actor=Actor(2,13)
                self.critics=torch.nn.Linear(2,1)
                self.pass_obs_keys_to_actor=[]
            def get_state_embedding(self,obs,rl2s,time_idxs):
                return self.tstep_encoder(obs['x']),None
        policy=Policy();install_actor(policy,.1)
        groups,teacher,anchor=target_tensors([self.record()]*3)
        batch=SimpleNamespace(obs={'x':torch.tensor([[[1.],[2.],[3.]]]),
            'soft_valid':torch.tensor([[[1.],[0.],[0.]]]),'soft_groups':groups[None],
            'soft_teacher':teacher[None],'soft_anchor':anchor[None]},
            rl2s=torch.zeros(1,3,14),time_idxs=torch.arange(3).reshape(1,3,1))
        before={k:v.detach().clone() for k,v in policy.named_parameters()}
        optimizer=torch.optim.AdamW(policy.parameters(),lr=.01,weight_decay=.1)
        for _ in range(2):
            optimizer.zero_grad();policy(batch,log_step=True).backward();optimizer.step()
        self.assertFalse(policy.tstep_encoder[1].training)
        self.assertGreater(float(policy.tstep_encoder[0].weight.grad.abs().sum()),0.)
        for name,parameter in policy.named_parameters():
            if name.startswith('critics.'):
                self.assertIsNone(parameter.grad)
                self.assertTrue(torch.equal(parameter,before[name]))
            else:self.assertFalse(torch.equal(parameter,before[name]),name)
        self.assertEqual(policy.update_info['Teacher Decisions'],1)

    def record(self):
        return {"groups":[[0],[1]],"teacher":[.25,.75],"anchor":[.8,.2]}

    def test_anchor_has_the_declared_gradient_and_illegal_logits_cancel(self):
        logits = torch.zeros(1,13,requires_grad=True)
        loss, teacher, anchor = distillation_loss(logits.softmax(-1),[self.record()],.1)
        loss.backward()
        self.assertAlmostEqual(logits.grad[0,0].item(),.5-(.9*.25+.1*.8),places=6)
        self.assertAlmostEqual(logits.grad[0,1].item(),-.195,places=6)
        self.assertTrue(torch.allclose(logits.grad[0,2:],torch.zeros(11),atol=1e-7))
        self.assertAlmostEqual(loss.item(),.9*teacher.item()+.1*anchor.item(),places=6)

    def test_aliases_share_one_structural_target_and_malformed_targets_fail(self):
        p = torch.tensor([[.1,.2,.7]+[0.]*10],requires_grad=True)
        record = {"groups":[[0,1],[2]],"teacher":[.3,.7],"anchor":[.3,.7]}
        loss,_,_ = distillation_loss(p,[record],.1)
        self.assertAlmostEqual(loss.item(),0.,places=6)
        for change in ({"groups":[[0,1],[1]]},{"teacher":[0.,0.]},{"anchor":[float('nan'),1.]}):
            with self.subTest(change=change),self.assertRaises(ValueError):
                distillation_loss(p,[{**record,**change}],.1)
        with self.assertRaisesRegex(ValueError,"legal mass"):
            distillation_loss(torch.zeros(1,13),[record],.1)

    def test_input_hash_binds_values_types_and_shapes_but_not_dictionary_order(self):
        obs={"x":torch.ones(1,1,3),"y":torch.zeros(1,1,2,dtype=torch.int64)}
        rl2=torch.zeros(1,1,14);times=torch.zeros(1,1,1,dtype=torch.int64)
        expected=input_digest(obs,rl2,times)
        self.assertEqual(expected,input_digest(dict(reversed(list(obs.items()))),rl2,times))
        self.assertNotEqual(expected,input_digest({**obs,"y":obs['y'].int()},rl2,times))
        self.assertNotEqual(expected,input_digest(obs,rl2+1,times))
        with self.assertRaisesRegex(ValueError,"exact causal"):
            input_digest(obs,torch.zeros(1,2,14),times)

    def test_native_rl2_reconstruction_catches_prior_action_drift_and_labels_reused_forward(self):
        from amago.loading import RLData, RLData_pad_collate
        mask=torch.tensor([[False,False]+[True]*11]*3)
        def sample():
            return RLData(obs={"x":torch.arange(3).reshape(3,1),"illegal_actions":mask.clone()},
                rews=torch.tensor([[.25],[.5]]),dones=torch.tensor([[False],[True]]),
                actions=torch.nn.functional.one_hot(torch.tensor([0,1]),13).float(),
                time_idxs=torch.arange(3).reshape(3,1))
        batch=RLData_pad_collate([sample()]);records=[]
        for i in range(2):
            inputs={"obs":{k:v[:,i:i+1] for k,v in batch.obs.items()},
                    "rl2s":batch.rl2s[:,i:i+1],"time_idxs":batch.time_idxs[:,i:i+1]}
            records.append({**self.record(),"input":capture_inputs(inputs),"reusedForward":False})
        payload={"states":[None]*3,"actions":[0,1,-1],
            "soft_policy":{"schema":"uu-soft-policy@1","policyId":"teacher","records":records}}
        dataset=SimpleNamespace(_load_json=lambda _:payload,load_filename=lambda _:None)
        wrapper=SimpleNamespace(_process_data=lambda _:sample())
        result=replay_sample(dataset,wrapper,'fixture','teacher')
        self.assertEqual(result[2:],([0,1],[]))
        wrong=sample();wrong.rl2s[1,1:]=torch.nn.functional.one_hot(torch.tensor(4),13).float()
        wrapper._process_data=lambda _:copy.deepcopy(wrong)
        with self.assertRaisesRegex(ValueError,"mismatch at \\[1\\]"):
            replay_sample(dataset,wrapper,'fixture','teacher')
        records[1]['reusedForward']=True
        self.assertEqual(replay_sample(dataset,wrapper,'fixture','teacher')[2:],([0],[1]))


if __name__=="__main__":unittest.main()
