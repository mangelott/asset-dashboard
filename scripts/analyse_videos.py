#!/usr/bin/env python3
"""
Analyse YouTube trading strategy videos using Whisper (ASR) + Claude API (vision).
Outputs a consolidated strategy specification document in Markdown.

Env vars:
  ANTHROPIC_API_KEY  — required
  YOUTUBE_URLS       — comma-separated YouTube URLs
  OUTPUT_FILE        — output filename stem (default: strategy_gold_v1)
"""

import base64
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

# ── Config ───────────────────────────────────────────────────────────────────
API_KEY      = os.environ.get('ANTHROPIC_API_KEY', '')
YOUTUBE_URLS = [u.strip() for u in os.environ.get('YOUTUBE_URLS', '').split(',') if u.strip()]
OUTPUT_FILE  = os.environ.get('OUTPUT_FILE', 'strategy_gold_v1')
OUTPUT_DIR   = Path('strategies')

FRAME_INTERVAL = 10    # seconds between extracted frames
CHUNK_S        = 90    # analysis window in seconds
MAX_FRAMES     = 5     # max frames sent per Claude call
FRAME_WIDTH    = 1024  # px wide (ffmpeg scale)

# haiku for cheap per-chunk extraction; sonnet for quality synthesis
CHUNK_MODEL = 'claude-haiku-4-5-20251001'
SYNTH_MODEL = 'claude-sonnet-5'


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def sh(cmd: list, capture: bool = False) -> str:
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(str(c) for c in cmd)}\n{result.stderr[-600:]}")
    return result.stdout.strip() if capture else ''


# ── Download ──────────────────────────────────────────────────────────────────
def download_video(url: str, out_dir: Path) -> tuple:
    """Download video (max 720p mp4) → (path, title)."""
    log(f"  Fetching title...")
    title = sh(['yt-dlp', '--print', 'title', '--no-playlist', url], capture=True)

    log(f"  Downloading: {title}")
    sh([
        'yt-dlp', '--no-playlist',
        '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
        '--merge-output-format', 'mp4',
        '-o', str(out_dir / 'video.%(ext)s'),
        url,
    ])

    matches = list(out_dir.glob('video.*'))
    if not matches:
        raise FileNotFoundError(f"Download produced no file for: {url}")
    return matches[0], title


# ── Frames ────────────────────────────────────────────────────────────────────
def extract_frames(video_path: Path, frames_dir: Path) -> list:
    """Extract 1 frame every FRAME_INTERVAL seconds → [(timestamp, Path)]."""
    frames_dir.mkdir(parents=True, exist_ok=True)
    sh([
        'ffmpeg', '-i', str(video_path),
        '-vf', f'fps=1/{FRAME_INTERVAL},scale={FRAME_WIDTH}:-2',
        '-q:v', '4',
        str(frames_dir / 'f_%05d.jpg'),
        '-hide_banner', '-loglevel', 'error',
    ])
    frames = sorted(frames_dir.glob('f_*.jpg'))
    result = [(float(i * FRAME_INTERVAL), f) for i, f in enumerate(frames)]
    log(f"  Extracted {len(result)} frames")
    return result


# ── Transcription ─────────────────────────────────────────────────────────────
def transcribe(video_path: Path) -> list:
    """Transcribe with Whisper small → [{start, end, text}]."""
    import whisper
    log("  Loading Whisper model (small)...")
    model = whisper.load_model('small')
    log("  Transcribing audio (this takes a few minutes)...")
    result = model.transcribe(str(video_path), language='en', fp16=False)
    segs = [
        {'start': s['start'], 'end': s['end'], 'text': s['text'].strip()}
        for s in result['segments']
    ]
    log(f"  Transcribed: {len(segs)} segments")
    return segs


def transcript_slice(segments: list, t0: float, t1: float) -> str:
    return ' '.join(s['text'] for s in segments if s['start'] < t1 and s['end'] > t0)


# ── Claude calls ──────────────────────────────────────────────────────────────
def encode_jpg(path: Path) -> tuple:
    return base64.standard_b64encode(path.read_bytes()).decode(), 'image/jpeg'


def analyse_chunk(client, frames: list, transcript: str, t0: float, t1: float, title: str):
    """Send frames + transcript window to Claude. Returns text or None."""
    if not frames and not transcript.strip():
        return None

    content = []
    for ts, fp in frames:
        b64, mime = encode_jpg(fp)
        content += [
            {'type': 'text', 'text': f'[{int(ts)}s]'},
            {'type': 'image', 'source': {'type': 'base64', 'media_type': mime, 'data': b64}},
        ]

    content.append({'type': 'text', 'text': f"""Transcript ({int(t0)}s–{int(t1)}s):
"{transcript}"

Video: "{title}"

Extract any trading rules, signals, or concepts visible on the charts or mentioned in audio.
Focus on: entry signals, exit signals, stop loss, take profit, indicators, timeframes, patterns, key levels.
Be concise and structured.
If this segment contains no trading content, reply only: SKIP"""})

    resp = client.messages.create(
        model=CHUNK_MODEL,
        max_tokens=700,
        messages=[{'role': 'user', 'content': content}],
    )
    text = resp.content[0].text.strip()
    return None if text.upper().startswith('SKIP') else text


def process_video(client, url: str, work_dir: Path) -> dict:
    """Full pipeline for one URL → analysis dict."""
    log(f"\n{'─'*55}")
    log(f"URL: {url}")

    vdir = work_dir / f"v{abs(hash(url)) % 9999:04d}"
    vdir.mkdir(parents=True, exist_ok=True)

    try:
        video_path, title = download_video(url, vdir)
        frames_all = extract_frames(video_path, vdir / 'frames')
        segments = transcribe(video_path)

        duration = (frames_all[-1][0] + FRAME_INTERVAL) if frames_all else 0
        chunks = []
        t = 0.0

        while t < duration:
            t_end = t + CHUNK_S
            chunk_frames = [(ts, fp) for ts, fp in frames_all if t <= ts < t_end]

            if len(chunk_frames) > MAX_FRAMES:
                step = max(1, len(chunk_frames) // MAX_FRAMES)
                chunk_frames = chunk_frames[::step][:MAX_FRAMES]

            transcript = transcript_slice(segments, t, t_end)
            log(f"  Chunk {int(t)}s–{int(t_end)}s  ({len(chunk_frames)} frames)")

            try:
                result = analyse_chunk(client, chunk_frames, transcript, t, t_end, title)
                if result:
                    chunks.append({'t0': t, 't1': t_end, 'text': result})
            except Exception as e:
                log(f"  Warning: chunk failed — {e}")

            t = t_end

        log(f"  Done — {len(chunks)} relevant chunks found")
        return {'title': title, 'url': url, 'chunks': chunks}

    except Exception as e:
        log(f"  ERROR: {e}")
        return {'title': url, 'url': url, 'error': str(e), 'chunks': []}


def synthesise(client, analyses: list) -> str:
    """Combine all chunk analyses into a final strategy document."""
    log("\nSynthesising final strategy document...")

    parts = []
    for a in analyses:
        if 'error' in a:
            parts.append(f"## {a['title']} — FAILED: {a['error']}\n")
            continue
        parts.append(f"## {a['title']}\n{a['url']}\n")
        for c in a['chunks']:
            parts.append(f"### {int(c['t0'])}s–{int(c['t1'])}s\n{c['text']}\n")

    combined = '\n'.join(parts)

    resp = client.messages.create(
        model=SYNTH_MODEL,
        max_tokens=4000,
        messages=[{'role': 'user', 'content': f"""You have analysed {len(analyses)} YouTube videos teaching a Gold (XAUUSD) trading strategy.
Below are extracted notes from every video segment that contained trading content.

{combined}

Synthesise everything into one definitive, actionable strategy document.
Resolve conflicts by preferring the most specific/quantitative version.
Remove duplicates. Structure it exactly as follows:

# Gold (XAUUSD) Trading Strategy

## Overview
Core concept in 2–3 sentences.

## Markets & Sessions
Trading sessions, liquidity windows, any session restrictions.

## Timeframes
- Higher timeframe (bias/trend): ...
- Entry timeframe: ...
- Trigger/execution timeframe: ...

## Pre-conditions (Must be true before any entry)
Numbered list of required market conditions.

## Entry Rules
Numbered, specific, unambiguous. Include exact indicator values, candle patterns, confirmation signals.

## Exit Rules
- Take profit: (method, levels, targets)
- Stop loss: (placement rule)
- Trail / partial close: (if mentioned)

## Risk Management
- Risk per trade: ...
- Max daily loss: ...
- Max concurrent trades: ...
- Position sizing: ...

## Indicators & Settings
| Indicator | Settings | Purpose |
|-----------|----------|---------|
| ... | ... | ... |

## Ideal Setup Examples
2–3 concrete setups based on what was shown in the videos.

## Things to Avoid
Mistakes, conditions, or setups explicitly warned against.

## Open Questions
Things mentioned but not fully specified — flag for further research.

Use numbers wherever possible. Mark uncertain items with (?).
"""}],
    )
    return resp.content[0].text


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    if not API_KEY:
        sys.exit("ERROR: ANTHROPIC_API_KEY is not set")
    if not YOUTUBE_URLS:
        sys.exit("ERROR: YOUTUBE_URLS is not set (comma-separated URLs)")

    try:
        import anthropic
        import whisper  # noqa: F401
    except ImportError as e:
        sys.exit(f"Missing dependency: {e}\nRun: pip install openai-whisper anthropic")

    import anthropic as _anthropic
    client = _anthropic.Anthropic(api_key=API_KEY)

    OUTPUT_DIR.mkdir(exist_ok=True)

    log(f"Videos to process: {len(YOUTUBE_URLS)}")
    for i, url in enumerate(YOUTUBE_URLS, 1):
        log(f"  {i}. {url}")

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        analyses = [process_video(client, url, work) for url in YOUTUBE_URLS]

    strategy = synthesise(client, analyses)

    ts = datetime.now().strftime('%Y%m%d_%H%M')
    out = OUTPUT_DIR / f"{OUTPUT_FILE}_{ts}.md"
    out.write_text(strategy, encoding='utf-8')

    log(f"\nSaved: {out}")
    print(f"\n{'='*60}\nPREVIEW (first 2000 chars):\n{'='*60}")
    print(strategy[:2000])
    if len(strategy) > 2000:
        print(f"\n... ({len(strategy) - 2000} more chars in {out})")


if __name__ == '__main__':
    main()
