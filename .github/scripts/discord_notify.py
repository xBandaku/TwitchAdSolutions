import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

EVENT = os.environ["GITHUB_EVENT_NAME"]
ACTION = os.environ.get("GITHUB_EVENT_ACTION", "")
REPO = os.environ["GITHUB_REPOSITORY"]
WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "")
with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as f:
    data = json.load(f)

if not WEBHOOK:
    print("DISCORD_WEBHOOK_URL secret is missing; skipping.")
    sys.exit(0)

def short(value, limit=900):
    value = str(value or "").strip()
    return value[:limit - 1] + "…" if len(value) > limit else value

def link(text, url):
    return f"[{short(text, 100)}]({url})" if url and str(url).startswith("https://github.com/") else short(text, 100)

actor = data.get("sender") or {}
name = actor.get("login") or os.environ.get("GITHUB_ACTOR", "GitHub")
title = ""
description = ""
url = f"https://github.com/{REPO}"
color = 0x5865F2
fields = []

if EVENT == "push":
    commits = data.get("commits", [])
    branch = (data.get("ref") or "").replace("refs/heads/", "")
    title = "📦 New commits pushed"
    color = 0x2ECC71
    url = data.get("compare") or url
    lines = [f"• {link((c.get('id') or '')[:7], c.get('url'))} — {short(c.get('message', '').splitlines()[0], 140)}" for c in commits[:10]]
    description = "\n".join(lines) or "Branch updated."
    if len(commits) > 10:
        description += f"\n…and {len(commits)-10} more commits."
    fields = [{"name": "Branch", "value": short(branch, 256), "inline": True},
              {"name": "Commits", "value": str(len(commits)), "inline": True}]
elif EVENT == "pull_request":
    pr = data.get("pull_request", {})
    merged = pr.get("merged", False)
    state = "merged" if merged else ACTION
    title = f"🔀 Pull request {state}"
    color = 0x9B59B6 if merged else (0xE74C3C if ACTION == "closed" else 0x3498DB)
    url = pr.get("html_url") or url
    description = short(pr.get("title"), 400)
    fields = [{"name": "PR", "value": f"#{pr.get('number', data.get('number', '?'))}", "inline": True},
              {"name": "Branch", "value": short(f"{pr.get('head', {}).get('ref', '?')} → {pr.get('base', {}).get('ref', '?')}", 256), "inline": True}]
elif EVENT == "issues":
    issue = data.get("issue", {})
    title = f"📌 Issue {ACTION}"
    color = 0x2ECC71 if ACTION == "opened" else 0xE67E22
    url = issue.get("html_url") or url
    description = short(issue.get("title"), 400)
    fields = [{"name": "Issue", "value": f"#{issue.get('number', '?')}", "inline": True}]
elif EVENT == "release":
    release = data.get("release", {})
    title = f"🚀 Release {ACTION}"
    color = 0xF1C40F
    url = release.get("html_url") or url
    description = short(release.get("body") or "New release published.", 1800)
    fields = [{"name": "Version", "value": short(release.get("tag_name", "?"), 256), "inline": True}]
else:
    sys.exit(0)

embed = {"title": short(title, 256), "description": short(description, 4000),
         "url": url, "color": color, "fields": fields,
         "footer": {"text": short(f"{REPO} • {name}", 2048)},
         "timestamp": datetime.now(timezone.utc).isoformat()}
payload = json.dumps({"username": "GitHub Updates", "allowed_mentions": {"parse": []}, "embeds": [embed]}).encode()
req = urllib.request.Request(WEBHOOK, data=payload, headers={"Content-Type": "application/json", "User-Agent": "GitHub-Actions-Discord-Notifier"}, method="POST")
with urllib.request.urlopen(req, timeout=20) as response:
    print(f"Discord response: {response.status}")
