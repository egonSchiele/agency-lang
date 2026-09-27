"""Export the saved head after the user stopped training; no optimizer or fitting."""
import argparse
import json
from pathlib import Path
from safetensors.torch import load_file, save_file
from laya.agent import Agent

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run', required=True)
parser.add_argument('--base-model', required=True)
args = parser.parse_args()
folder = Path(args.run)
manifest=json.loads((folder/'manifest.json').read_text())
progress=[json.loads(line) for line in (folder/'training.jsonl').read_text().splitlines()]
candidates = [r for r in progress if r['event'] == 'validation' and r['improved']]
if not candidates:
    raise ValueError('No improved epoch was saved; use the original base checkpoint.')
selected = candidates[-1]
agent=Agent(args.base_model,device='cpu')
loaded=agent.model.load_state_dict(load_file(str(folder/'best-head.safetensors')),strict=False)
assert not loaded.unexpected_keys
assert all(name.startswith('encoder.') for name in loaded.missing_keys)
checkpoint=folder/'checkpoint'
checkpoint.mkdir(exist_ok=False)
save_file({name:tensor.detach().contiguous() for name,tensor in agent.model.state_dict().items()},str(checkpoint/'model.safetensors'))
agent.model.encoder.config.save_pretrained(checkpoint/'encoder')
agent.tok.save_pretrained(checkpoint/'tokenizer')
config=dict(agent.cfg)
config['model_name']='laya-sms-head-v1'
config['temperature']=list(agent.temperature)
config['temperature'][2]=1.0
config.pop('temperature_by_options',None)
config['training']={'method':manifest['method'],'bestEpoch':selected['epoch'],'seed':manifest['seed'],'trainingRows':len(manifest['trainIds']),'validationRows':len(manifest['validationIds']),'stoppedByUser':True,'calibration':'No post-training fit; use raw trained logits (temperature 1).'}
(checkpoint/'rl_agent_config.json').write_text(json.dumps(config,indent=2)+'\n')
report={'bestEpoch':selected['epoch'],'validation':selected['metrics'],'checkpoint':str(checkpoint),'stoppedByUser':True,'temperature':1.0,'postTrainingCalibrationPerformed':False}
(folder/'export.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report),flush=True)
