"""음원 분리 — Demucs(기존 ~/.venvs/demucs 가상환경을 서브프로세스로 호출).

vocal → htdemucs 'vocals', guitar → htdemucs_6s 'guitar'.
이 환경의 torchaudio는 WAV 저장이 안 되므로 MP3(320k)로 받은 뒤 ffmpeg로 읽는다.
분리 결과 폴더는 남겨 두어 품질을 직접 들어볼 수 있게 한다.
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

MODEL = {"vocal": ("htdemucs", "vocals"), "guitar": ("htdemucs_6s", "guitar")}


def find_stem(stems_dir: Path, source: str) -> Path | None:
    """기존 분리 폴더에서 대상 트랙을 찾는다 (demucs 출력 구조 또는 make-stems 4트랙 구조)."""
    _, stem = MODEL[source]
    names = {"vocals": ["vocals", "4-보컬외"], "guitar": ["guitar", "3-기타"]}[stem]
    for p in sorted(stems_dir.rglob("*")):
        if p.suffix.lower() in (".wav", ".mp3", ".flac") and p.stem in names:
            return p
    return None


def separate(audio: Path, source: str, out_dir: Path, device: str = "mps") -> Path:
    model, stem = MODEL[source]
    venv = Path(os.environ.get("DEMUCS_VENV", Path.home() / ".venvs" / "demucs"))
    demucs = venv / "bin" / "demucs"
    if not demucs.exists():
        raise SystemExit(f"Demucs 가상환경이 없습니다: {venv} (DEMUCS_VENV 로 지정하거나 --no-separate 사용)")
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [str(demucs), "-n", model, "-d", device, "--two-stems", stem, "--mp3", "--mp3-bitrate", "320",
           "-o", str(out_dir), str(audio)]
    print("  $", " ".join(cmd))
    subprocess.run(cmd, check=True)
    result = out_dir / model / audio.stem / f"{stem}.mp3"
    if not result.exists():
        raise SystemExit(f"분리 결과가 없습니다: {result}")
    return result
