import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

EVENT = os.environ["GITHUB_EVENT_NAME"]
ACTION = os.environ.get("GITHUB_EVENT_ACTION", "")
REPO = os.environ["GITHUB_REPOSITORY"]
WEBHOOK = os.environ.get("DISCORD_WEBHOOK_URL", "")
with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as file:
    event = json.load(file)

if not WEBHOOK:
    print("DISCORD_WEBHOOK_URL is not configured; notification skipped.")
    sys.exit(0)


def clip(value, limit):
    value = str(value or "").strip()
    return value if len(value) <= limit else value[:limit - 1] + "…"


def safe_url(value):
    value = str(value or "")
    return value if value.startswith("https://github.com/") else ""


def markdown_link(label, url):
    label = clip(label, 120).replace("[", "\\[").replace("]", "\\]")
    url = safe_url(url)
    return f"[{label}]({url})" if url else label


def field(name, value, inline=True):
    return {"name": clip(name, 256), "value": clip(value or "—", 1024), "inline": inline}


actor = event.get("sender") or {}
actor_name = actor.get("login") or os.environ.get("GITHUB_ACTOR", "GitHub")
actor_avatar = actor.get("avatar_url")
title, description, fields = "", "", []
url = f"https://github.com/{REPO}"
color = 0x5865F2

if EVENT == "push":
    commits = event.get("commits") or []
    branch = (event.get("ref") or "").removeprefix("refs/heads/")
    title, color = "📦 Commits pushed", 0x2ECC71
    url = safe_url(event.get("compare")) or url
    lines = []
    for commit in commits[:12]:
        sha = (commit.get("id") or "")[:7]
        subject = (commit.get("message") or "").splitlines()[0] if commit.get("message") else "Commit"
        added = len(commit.get("added") or [])
        modified = len(commit.get("modified") or [])
        removed = len(commit.get("removed") or [])
        lines.append(f"• {markdown_link(sha, commit.get('url'))} {clip(subject, 130)} (＋{added} ~{modified} −{removed} files)")
    description = "\n".join(lines) or "Branch updated."
    if len(commits) > 12:
        description += f"\n…and {len(commits) - 12} more commits."
    fields = [field("Branch", branch), field("Commits in payload", len(commits))]
    if event.get("forced"):
        fields.append(field("Force push", "Yes"))
    if event.get("deleted"):
        title = "🗑️ Branch deleted"
    elif event.get("created"):
        title = "🌱 Branch created"
elif EVENT == "pull_request":
    pr = event.get("pull_request") or {}
    merged = bool(pr.get("merged"))
    status = "merged" if merged else ACTION.replace("_", " ")
    title = f"🔀 Pull request {status}"
    color = 0x9B59B6 if merged else (0xE74C3C if ACTION == "closed" else 0x3498DB)
    url = safe_url(pr.get("html_url")) or url
    description = clip(pr.get("title") or "Untitled pull request", 500)
    fields = [
        field("Pull request", f"#{pr.get('number', event.get('number', '?'))}"),
        field("Branches", f"{pr.get('head', {}).get('ref', '?')} → {pr.get('base', {}).get('ref', '?')}", False),
        field("Changes", f"+{pr.get('additions', 0)} / -{pr.get('deletions', 0)} lines • {pr.get('changed_files', 0)} files", False),
    ]
    actor_avatar = (pr.get("user") or {}).get("avatar_url") or actor_avatar
elif EVENT == "issues":
    issue = event.get("issue") or {}
    title = f"📌 Issue {ACTION}"
    color = 0x2ECC71 if ACTION in ("opened", "reopened") else 0xE67E22
    url = safe_url(issue.get("html_url")) or url
    description = clip(issue.get("title") or "Untitled issue", 500)
    labels = ", ".join(label.get("name", "") for label in (issue.get("labels") or []))
    fields = [field("Issue", f"#{issue.get('number', '?')}")]
    if labels:
        fields.append(field("Labels", labels, False))
    actor_avatar = (issue.get("user") or {}).get("avatar_url") or actor_avatar
elif EVENT == "release":
    release = event.get("release") or {}
    title, color = "🚀 New release published", 0xF1C40F
    url = safe_url(release.get("html_url")) or url
    description = clip(release.get("body") or "A new version is available.", 3500)
    fields = [field("Version", release.get("tag_name") or "Unknown"),
              field("Release", release.get("name") or release.get("tag_name") or "Release", False)]
    if release.get("prerelease"):
        fields.append(field("Pre-release", "Yes"))
    actor_avatar = (release.get("author") or {}).get("avatar_url") or actor_avatar
else:
    icons = {
        "create": "🌱", "delete": "🗑️", "issue_comment": "💬",
        "pull_request_review": "🔍", "pull_request_review_comment": "💬",
        "discussion": "🗣️", "discussion_comment": "💬",
        "fork": "🍴", "watch": "👀", "star": "⭐",
        "label": "🏷️", "milestone": "🎯", "deployment": "🚀",
        "deployment_status": "🚦", "status": "📊",
        "check_run": "🧪", "check_suite": "🧪",
        "workflow_dispatch": "🔔",
    }
    icon = icons.get(EVENT, "🔔")
    title = f"{icon} {EVENT.replace('_', ' ').title()}"
    if ACTION:
        title += f" · {ACTION.replace('_', ' ')}"
    obj = next((event[k] for k in (
        "comment", "review", "discussion", "issue", "pull_request",
        "release", "deployment", "check_run", "check_suite",
        "milestone", "label", "forkee",
    ) if isinstance(event.get(k), dict)), {})
    url = safe_url(obj.get("html_url")) or safe_url(event.get("compare")) or url
    subject = obj.get("title") or obj.get("name") or obj.get("message")
    description = clip(subject or f"{actor_name} triggered a {EVENT.replace('_', ' ')} event.", 1500)
    fields = [field("Event", EVENT), field("Action", ACTION or "Triggered")]
    if event.get("ref"):
        fields.append(field("Ref", event["ref"], False))
    if event.get("ref_type"):
        fields.append(field("Ref type", event["ref_type"]))
    if obj.get("state"):
        fields.append(field("State", obj["state"]))
    if obj.get("number"):
        fields.append(field("Number", obj["number"]))
    color = 0x5865F2

embed = {
    "title": clip(title, 256),
    "description": clip(description, 4096),
    "url": url,
    "color": color,
    "fields": fields[:25],
    "footer": {"text": clip(f"{REPO} • {actor_name}", 2048)},
    "timestamp": datetime.now(timezone.utc).isoformat(),
}
if actor_avatar and str(actor_avatar).startswith("https://"):
    embed["author"] = {"name": clip(actor_name, 256), "icon_url": actor_avatar}

payload = json.dumps({
    "username": "GitHub Updates",
    "allowed_mentions": {"parse": []},
    "embeds": [embed],
}).encode("utf-8")

request = urllib.request.Request(
    WEBHOOK,
    data=payload,
    headers={"Content-Type": "application/json", "User-Agent": "GitHub-Actions-Discord-Notifier"},
    method="POST",
)
for attempt in range(3):
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            print(f"Discord response: {response.status}")
        break
    except urllib.error.HTTPError as exc:
        if exc.code == 429 and attempt < 2:
            retry_after = float(exc.headers.get("Retry-After", "2"))
            time.sleep(min(max(retry_after, 1), 15))
            continue
        raise
