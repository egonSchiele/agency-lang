import argparse
import hashlib, json
from pathlib import Path
import torch
from safetensors import safe_open
from laya.agent import Agent
from laya.common import collate_items

parser = argparse.ArgumentParser(description='Verify frozen weights and native inference after export.')
parser.add_argument('--run', required=True)
parser.add_argument('--base-model', required=True)
parser.add_argument('--report', required=True)
args = parser.parse_args()
folder = Path(args.run)
base = Path(args.base_model)
checkpoint=folder/'checkpoint'
changed_head=0
checked_encoder=0
with safe_open(str(base/'model.safetensors'),framework='pt') as original, safe_open(str(checkpoint/'model.safetensors'),framework='pt') as trained:
    assert sorted(original.keys())==sorted(trained.keys())
    for name in original.keys():
        left=original.get_tensor(name).float()
        right=trained.get_tensor(name).float()
        identical=torch.equal(left,right)
        if name.startswith(('encoder.','act_head.')):
            assert identical,name
            if name.startswith('encoder.'):
                checked_encoder+=1
        elif not identical:
            changed_head+=1
assert changed_head>0,'No trained weights changed'
with safe_open(str(folder/'best-head.safetensors'),framework='pt') as selected, safe_open(str(checkpoint/'model.safetensors'),framework='pt') as trained:
    for name in selected.keys():
        assert torch.equal(selected.get_tensor(name),trained.get_tensor(name)),name
print(json.dumps({'frozenEncoderTensorsVerified':checked_encoder,'changedHeadTensors':changed_head}),flush=True)
agent=Agent(str(checkpoint.absolute()),device='mps')
assert agent.device.type=='mps'
assert 'temperature_by_options' not in agent.cfg
validation=[json.loads(line) for line in (folder/'validation.jsonl').read_text().splitlines()][:16]
max_difference=0
for row in validation:
    native=agent.predict(row['state'],row['questions'])['answers']['spam']['noul']
    item=agent._encode_state(row['state'],['spam'],{'spam':agent._to_internal(row['questions']['spam'])})[0]
    batch=collate_items([[item]],agent.tok.pad_token_id)
    keys=['input_ids','attention_mask','marker_pos','marker_mask','qtype']
    inputs={key:batch[key].to(agent.device) for key in keys}
    with torch.no_grad():
        logits,_=agent.model(**inputs)
        expected=round(float((logits/agent.temperature[2]).softmax(-1)[0,1]),4)
    max_difference=max(max_difference,abs(native-expected))
    assert abs(native-expected)<=0.0001,(native,expected)
report={
 'frozenEncoderTensorsVerified':checked_encoder,
 'changedHeadTensors':changed_head,
 'nativeValidationExamplesChecked':len(validation),
 'maxProbabilityDifference':max_difference,
 'checkpointSha256':hashlib.file_digest((checkpoint/'model.safetensors').open('rb'),'sha256').hexdigest(),
 'temperature':agent.temperature[2],
}
with Path(args.report).open('x') as stream:
    stream.write(json.dumps(report,indent=2)+'\n')
print(json.dumps(report),flush=True)
