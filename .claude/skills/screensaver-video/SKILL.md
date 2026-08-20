---
name: screensaver-video
description: Generate seamlessly-looping 1920x480 screensaver/wallpaper videos for the open-quake touch panel using T.J.'s ComfyUI server (192.168.1.95:8188, RTX 3090). Use this whenever T.J. asks for a screensaver video, panel wallpaper, animated background, looping video, a video "like the DK-Suite wallpapers", or to animate a scene (aurora, matrix rain, city, landscape, etc.) for the panel — even if he doesn't say "screensaver" or "loop". Covers the full pipeline — Flux still → Wan 2.2 first-last-frame loop → verify → trim → deliver — with validated settings; do not improvise a different workflow when this applies.
---

# Looping screensaver videos for the open-quake panel

Produces mp4s for the panel's Screensaver app (see `docs/screensaver.md`: it plays mp4/webm/mov from a media folder, muted, each video through to the end). Because videos repeat, **the last frame must land back on the first frame** — everything below is built around that.

All settings here were validated 2026-08-20 against ComfyUI 0.31.0 on 192.168.1.95:8188 (RTX 3090 24GB, fp8 Wan 2.2 + Lightning LoRAs). Confirm the server is up with a quick GET `/system_stats` before promising anything; list models with GET `/models/<folder>` if in doubt.

## Pipeline overview

1. **Still first** — generate a 1920×480 start frame with Flux Schnell (~30s). Wan is image-to-video only; there is no t2v model on the box.
2. **Review the still** before spending GPU time — a bad still wastes a 10–25 min render.
3. **Loop render** — Wan 2.2 with `WanFirstLastFrameToVideo`, passing the **same image as `start_image` and `end_image`**. The model animates away from the frame and back to it. This is the whole looping trick.
4. **Verify** the last frame actually matches the first (see below) — never claim "seamless" unchecked.
5. **Trim the duplicate final frame** (last frame == first frame, so leaving it in causes a 1-frame stutter on repeat) and re-encode.
6. **Deliver**: save to `C:\Users\tschmitz\Videos\wallpapers-generated\` and send the file in chat (SendUserFile). Only copy into a screensaver media folder if T.J. asks.

## Driver

`scripts/comfy.py` (stdlib-only) submits API-format graphs and moves files:

```
python scripts/comfy.py run <workflow.json>              # submit + poll until complete
python scripts/comfy.py upload still.png name.png        # → ComfyUI input folder
python scripts/comfy.py download <fname> <sub> output <dest>   # video outputs use sub="video"
```

## Workflow templates

- `scripts/wf_still_template.json` — Flux Schnell t2i. Edit the prompt (node 2) and seed (node 5). Flux settings that work: 4 steps, cfg 1.0, euler/simple, `EmptySD3LatentImage` 1920×480. The fp8 checkpoint is all-in-one (model+clip+vae via `CheckpointLoaderSimple`).
- `scripts/wf_loop_template.json` — the loop render. Edit: motion prompt (8), negative (9), input image name (11), `length` (12), seed (13+14, keep identical), filename_prefix (17).

Sampler settings in the loop template are load-bearing — two-stage `KSamplerAdvanced` (high-noise model steps 0→2, low-noise 2→end, 4 steps total, cfg 1.0, euler/simple, `ModelSamplingSD3` shift 5.0, Lightning LoRAs at 1.0). Don't tweak these without reason; they're the Wan 2.2 Lightning recipe and they work.

## Frame math (16 fps output)

`length = seconds × 16 + 1` and must be ≡1 mod 4: **81 = 5s, 121 = 7.5s, 161 = 10s**. After trimming the duplicate last frame you get exactly N-1 frames = whole seconds.

- 1920×480 has the same pixel budget as 720p — Wan's sweet spot; fits the 3090 with fp8+Lightning.
- Validated render times: 81f ≈ 7–15 min, 121f ≈ 13–15 min. 161f is untested — expect ~20+ min and watch for VRAM pressure.
- Length choice: slow ambient scenes (sky, clouds, aurora) → 121; scenes with a static subject and only texture motion (rain, neon flicker) → 81 is plenty.

## Prompting the motion

- Describe **what moves and what stays still**, and say **"static camera"** — camera drift ruins loops.
- Anchor the subject: "car parked completely still", "landscape stays still", or Wan will move it.
- Negative prompt: `blurry, jerky motion, camera shake, zoom, pan, low quality, watermark, text overlay` (+ scene-specific, e.g. "car moving").
- Matching a reference video: probe it (`ffprobe`) and pull frames (`ffmpeg -vf "select='eq(n\,0)+eq(n\,90)'"`), look at them, and write the still prompt from what you see. Reference wallpapers on the panel are 1920×480 60fps ~5s.

## Verify the loop, then trim

Extract first and last frames and compare — both numerically and by eye:

```bash
ffmpeg -y -v error -i raw.mp4 -vf "select='eq(n\,0)+eq(n\,<N-1>)'" -vsync 0 f_%d.png
# RMSE via PIL: observed 8 (neon/rain scenes) to ~20 (soft clouds) on good loops.
# <25 AND visual composition match = pass. Composition shifted = fail → new seed or prompt fix.
```

Trim the duplicate last frame and finalize (keep `lt(n,N-1)`):

```bash
ffmpeg -y -v error -i raw.mp4 -vf "select='lt(n\,120)',setpts=N/16/TB" -r 16 \
  -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart Name_loop.mp4
```

Output is 16 fps (Wan 2.2 14B native). If T.J. wants it smoother, offer ffmpeg `minterpolate` to 60fps as a post-step — don't do it unasked.

## Batch runs (multiple videos)

ComfyUI queues prompts and runs them serially — POST all jobs at once (capture each `prompt_id`), then watch with one Monitor task polling `/history/<id>` every ~20s, emitting `<name> DONE` / `<name> ERROR` per job. Process each video (download → verify → trim → deliver) as its notification arrives. Don't foreground-wait on renders; a single Bash call will time out before a render finishes.

## Gotchas

- In Bash-tool loops on Windows, use **forward slashes** for absolute paths (`"C:/Program Files/..."`); backslash + `$var` in double quotes mangles the path.
- ffmpeg select-filter commas need escaping: `select='eq(n\,0)'`.
- `SaveVideo` writes to output subfolder `video/` — download with `sub="video"`.
- Node schemas: GET `/object_info/<NodeName>` when anything mismatches — verify, don't guess.
- One render at a time on the GPU; a queued job's poll just takes longer to start. Check `/queue` if unsure whether something is already running.
