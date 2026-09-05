"""Isolated local XTTS process. JSON lines in, base64 PCM out; no network calls."""
import base64
import contextlib
import json
from pathlib import Path
import sys


def main():
    output = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import torch
        from TTS.tts.configs.xtts_config import XttsConfig
        from TTS.tts.models.xtts import Xtts
        directory = Path(__file__).resolve().parents[1] / 'models' / 'xtts-v2'
        config = XttsConfig()
        config.load_json(str(directory / 'config.json'))
        model = Xtts.init_from_config(config)
        model.load_checkpoint(config, checkpoint_dir=str(directory), eval=True)
        if not torch.cuda.is_available():
            raise RuntimeError('XTTS GPU runtime unavailable; select Kokoro or install CUDA PyTorch.')
        model.cuda()
    print(json.dumps({'ready': True, 'speakers': list(model.speaker_manager.speakers)}), file=output, flush=True)
    reference_speaker = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            text = str(request['text'])
            if len(text) > 12000:
                raise ValueError('Speech request is too long')
            with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
                if request['speaker'] == '__jarvis_reference__':
                    if reference_speaker is None:
                        references = sorted((directory.parent / 'jarvis-reference').glob('sample-*.wav'))[:4]
                        if not references:
                            raise RuntimeError('JARVIS reference clips are missing from models/jarvis-reference.')
                        latent, embedding = model.get_conditioning_latents(
                            audio_path=[str(p) for p in references], gpt_cond_len=12, max_ref_length=8,
                            sound_norm_refs=True)
                        reference_speaker = {'gpt_cond_latent': latent, 'speaker_embedding': embedding}
                    speaker = reference_speaker
                else:
                    speaker = model.speaker_manager.speakers[request['speaker']]
                result = model.inference(text, 'en', speaker['gpt_cond_latent'], speaker['speaker_embedding'],
                    speed=float(request.get('speed', 1)), enable_text_splitting=True, temperature=.65)
            pcm = (np.clip(result['wav'], -1, 1) * 32767).astype('<i2')
            response = {'pcm': base64.b64encode(pcm.tobytes()).decode(), 'rate': 24000}
        except Exception as exc:
            response = {'error': str(exc)}
        print(json.dumps(response), file=output, flush=True)


if __name__ == '__main__':
    main()
