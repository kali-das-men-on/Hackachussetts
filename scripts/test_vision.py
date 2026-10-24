#!/usr/bin/env python3
"""Ask openai/gpt-6-luna (via OpenRouter) to analyze a report photo.

Usage: python3 scripts/test_vision.py [photo.jpg]
Reads OPENROUTER_API_KEY from the environment or the repo-root .env.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

MODEL = "openai/gpt-6-luna"
PHOTO = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "data/photos/R-1006.jpg")

key = os.environ.get("OPENROUTER_API_KEY")
if not key:
    sys.exit("OPENROUTER_API_KEY is not set")

with open(PHOTO, "rb") as f:
    image_b64 = base64.b64encode(f.read()).decode()

body = {
    "model": MODEL,
    "messages": [{
        "role": "user",
        "content": [
            {"type": "text", "text": (
                "This photo was submitted to a town 'report an issue' site. "
                "Describe what is shown, say whether there is a public issue "
                "(e.g. pothole, litter, broken light), and suggest a category."
            )},
            {"type": "image_url",
             "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
        ],
    }],
}

req = urllib.request.Request(
    "https://openrouter.ai/api/v1/chat/completions",
    data=json.dumps(body).encode(),
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
except urllib.error.HTTPError as e:
    sys.exit(f"HTTP {e.code}: {e.read().decode()}")

print(data["choices"][0]["message"]["content"])
print("\n---", data.get("model"), data.get("usage"))
