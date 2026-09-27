"""Serve a local fine-tuned checkpoint with Laya's standard System One API."""

import argparse
from pathlib import Path

import uvicorn
from laya.router import Router
from laya.serve import create_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--checkpoint', required=True)
    parser.add_argument('--port', type=int, default=8001)
    args = parser.parse_args()
    checkpoint = Path(args.checkpoint).absolute()
    if checkpoint.is_symlink() or not (checkpoint / 'model.safetensors').is_file():
        raise ValueError('Pass a local checkpoint directory containing model.safetensors.')
    router = Router(models={'english': str(checkpoint)}, device='mps')
    agent = router.load('english')
    if agent.device.type != 'mps':
        raise RuntimeError('Expected the Mac GPU for comparable inference timings.')
    print(f'Serving {checkpoint} as model english on 127.0.0.1:{args.port}', flush=True)
    uvicorn.run(create_app(router), host='127.0.0.1', port=args.port)


if __name__ == '__main__':
    main()
