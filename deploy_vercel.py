#!/usr/bin/env python3
"""Deploy the Agent Games gatekeeper endpoint to Vercel via the MCP connector.

Builds a create_deployment call with all runtime files inlined (utf-8),
then prints the raw result. One write operation -> one approval card.
"""
import json
import subprocess
import sys
from pathlib import Path

ENDPOINT_DIR = Path.home() / "workspace" / "agentgames" / "endpoint"

FILES = [
    "api/index.mjs",
    "core.mjs",
    "gatekeeper.mjs",
    "hmac.mjs",
    "store.mjs",
    "zkverify.mjs",
    "server.mjs",
    "vercel.json",
    "package.json",
]

files = []
for rel in FILES:
    p = ENDPOINT_DIR / rel
    data = p.read_text(encoding="utf-8")
    files.append({"file": rel, "data": data, "encoding": "utf-8"})
    print(f"  {rel}: {len(data)} bytes", file=sys.stderr)

args = {
    "requestBody": {
        "name": "agentgames-gatekeeper",
        "target": "production",
        "files": files,
    }
}

result = subprocess.run(
    ["/opt/hatch/bin/vercel", "call-tool", "--name", "create_deployment",
     "--arguments-json", json.dumps(args)],
    capture_output=True, text=True, timeout=300,
)
print("STDOUT:", result.stdout)
print("STDERR:", result.stderr, file=sys.stderr)
print("EXIT:", result.returncode)
