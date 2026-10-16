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


def code(value, limit=80):
    text = clip(value, limit).replace("`", "ˋ").replace("\n", " ")
    return f"`{text}`"


def humanize(value):
    return {
        "synchronize": "Updated",
        "ready_for_review": "Ready for review",
        "converted_to_draft": "Converted to draft",
        "review_requested": "Review requested",
        "review_request_removed": "Review request removed",
    }.get(value, str(value or "Updated").replace("_", " ").capitalize())


def changes(additions, deletions, files):
    return field("Changes", f"**+{additions}** / **−{deletions}** · **{files}** files")


def field(name, value, inline=True):
    return {"name": clip(name, 256), "value": clip(value or "—", 1024), "inline": inline}


def compare_stats(before, after):
    if not before or not after or set(before) == {"0"}:
        return None
    token = os.environ.get("GH_TOKEN")
    if not token:
        return None
    request = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/compare/{before}...{after}",
        headers={"Accept": "application/vnd.github+json",
                 "Authorization": f"Bearer {token}",
                 "User-Agent": "GitHub-Actions-Discord-Notifier"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            comparison = json.load(response)
        files = comparison.get("files", [])
        if len(files) >= 300 or comparison.get("total_commits", 0) > 250:
            return None
        return (sum(f.get("additions", 0) for f in files),
                sum(f.get("deletions", 0) for f in files), len(files))
    except (urllib.error.URLError, ValueError, KeyError) as exc:
        print(f"Commit comparison unavailable: {type(exc).__name__}")
        return None


actor = event.get("sender") or {}
actor_name = actor.get("login") or os.environ.get("GITHUB_ACTOR", "GitHub")
actor_avatar = actor.get("avatar_url")
repo_url = f"https://github.com/{REPO}"
github_icon = "https://github.githubassets.com/favicons/favicon.png"
title, description, fields = "", "", []
category = "Repository activity"
url = repo_url
color = 0x5865F2

if EVENT == "push":
    category = "Push"
    commits = event.get("commits") or []
    ref = event.get("ref") or ""
    ref_kind = "Tag" if ref.startswith("refs/tags/") else "Branch"
    branch = ref.removeprefix("refs/heads/").removeprefix("refs/tags/")
    count = len(commits)
    title = f"{count} {'commit' if count == 1 else 'commits'} pushed to {branch}"
    color = 0x3FB950
    url = safe_url(event.get("compare")) or repo_url
    lines = []
    for commit in commits[:5]:
        sha = (commit.get("id") or "")[:7]
        subject = (commit.get("message") or "Commit").splitlines()[0]
        lines.append(f"{markdown_link(sha, commit.get('url'))} {clip(subject, 150)}")
    description = "\n".join(lines) or "Repository reference updated."
    if count > 5:
        description += f"\n\n{markdown_link(f'View all {count} commits →', url)}"
    if not event.get("created") and not event.get("deleted"):
        stats = compare_stats(event.get("before"), event.get("after"))
        if stats is not None:
            fields = [changes(*stats)]
    if event.get("forced"):
        title = f"Force push to {branch}"
        color = 0xD29922
    if event.get("deleted"):
        title, description = f"{ref_kind} deleted", code(branch)
        color = 0xF85149
    elif event.get("created"):
        title = f"{ref_kind} created · {branch}"
elif EVENT == "pull_request":
    category = "Pull request"
    pr = event.get("pull_request") or {}
    number = pr.get("number", event.get("number", "?"))
    status = "Merged" if pr.get("merged") else humanize(ACTION)
    title = f"#{number} · {pr.get('title') or 'Untitled pull request'}"
    color = 0xA371F7 if pr.get("merged") else (0xF85149 if ACTION == "closed" else 0x58A6FF)
    if pr.get("draft") and not pr.get("merged") and ACTION != "closed":
        color = 0x8B949E
        if ACTION == "opened":
            status = "Draft opened"
    url = safe_url(pr.get("html_url")) or repo_url
    head, base = pr.get("head", {}).get("ref"), pr.get("base", {}).get("ref")
    description = f"**{status}**"
    if head and base:
        description += f" · {code(head)} → {code(base)}"
    if all(key in pr for key in ("additions", "deletions", "changed_files")):
        fields = [changes(pr["additions"], pr["deletions"], pr["changed_files"])]
elif EVENT == "issues":
    category = "Issue"
    issue = event.get("issue") or {}
    title = f"#{issue.get('number', '?')} · {issue.get('title') or 'Untitled issue'}"
    color = 0xA371F7 if ACTION == "closed" else 0x3FB950
    url = safe_url(issue.get("html_url")) or repo_url
    description = f"**{humanize(ACTION)}**"
    labels = " · ".join(code(label.get("name", ""), 50) for label in (issue.get("labels") or [])[:8])
    if labels:
        fields = [field("Labels", labels)]
elif EVENT == "release":
    category = "Release"
    release = event.get("release") or {}
    tag = release.get("tag_name") or "New version"
    title = release.get("name") or f"Release {tag}"
    color = 0xD29922 if release.get("prerelease") else 0x3FB950
    url = safe_url(release.get("html_url")) or repo_url
    status = "Pre-release available" if release.get("prerelease") else "New release available"
    description = f"**{status}**"
    if tag not in title:
        description += f" · {code(tag)}"
    description += "\n\n" + clip(release.get("body") or "A new version is ready to download.", 3200)
    assets = release.get("assets") or []
    downloads = [markdown_link(asset.get("name") or "Download", asset.get("browser_download_url")) for asset in assets[:4]]
    if downloads:
        fields = [field("Downloads", "\n".join(downloads), False)]
elif EVENT in ("issue_comment", "discussion_comment", "pull_request_review_comment", "pull_request_review"):
    category = "Review" if EVENT == "pull_request_review" else "Comment"
    context = event.get("pull_request") or event.get("issue") or event.get("discussion") or {}
    obj = event.get("review") or event.get("comment") or {}
    state = obj.get("state") or "commented"
    if EVENT == "pull_request_review":
        status = humanize(state) if ACTION == "submitted" else humanize(ACTION)
        title = f"Review {status.lower()}"
        color = {"approved": 0x3FB950, "changes_requested": 0xF85149}.get(state, 0x58A6FF)
    else:
        title = "Comment " + ("added" if ACTION == "created" else humanize(ACTION).lower())
        color = 0x58A6FF
    if context.get("number"):
        title += f" · #{context['number']}"
    url = safe_url(obj.get("html_url")) or safe_url(context.get("html_url")) or repo_url
    parts = []
    if context.get("title"):
        parts.append("**" + clip(context["title"], 250) + "**")
    if obj.get("body"):
        parts.append(clip(obj["body"], 700))
    description = "\n\n".join(parts) or "Conversation updated."
else:
    labels = {
        "create": "Reference created", "delete": "Reference deleted",
        "discussion": "Discussion", "fork": "Repository forked",
        "watch": "Repository starred", "label": "Label", "milestone": "Milestone",
        "deployment": "Deployment started", "deployment_status": "Deployment",
        "status": "Commit status", "check_run": "Check", "check_suite": "Check suite",
        "workflow_dispatch": "Notification preview",
    }
    category = labels.get(EVENT, humanize(EVENT))
    title = category
    obj = next((event[k] for k in (
        "discussion", "deployment_status", "deployment", "check_run", "check_suite",
        "milestone", "label", "forkee",
    ) if isinstance(event.get(k), dict)), {})
    url = safe_url(obj.get("html_url")) or safe_url(obj.get("target_url")) or safe_url(event.get("target_url")) or repo_url
    subject = obj.get("title") or obj.get("name") or obj.get("description") or event.get("description")
    result = obj.get("conclusion") or obj.get("state") or event.get("state")
    if result in ("success", "approved"):
        color = 0x3FB950
    elif result in ("failure", "error", "timed_out", "action_required"):
        color = 0xF85149
    elif result in ("pending", "in_progress", "queued"):
        color = 0xD29922
    status = humanize(result or ACTION) if result or ACTION else ""
    if status:
        title += f" · {status}"
    description = clip(subject, 800) if subject else ""
    if event.get("ref"):
        fields.append(field(humanize(event.get("ref_type") or "Reference"), code(event["ref"])))
    if obj.get("environment"):
        fields.append(field("Environment", code(obj["environment"])))
    if EVENT == "workflow_dispatch":
        title = "GitHub notifications are connected"
        description = "Repository updates, conversations, checks, and releases appear here."
    elif not description and not fields:
        description = markdown_link("View repository →", repo_url)

footer = {"text": clip(f"{actor_name} · {category}", 200)}
if actor_avatar and str(actor_avatar).startswith("https://"):
    footer["icon_url"] = actor_avatar
embed = {
    "author": {"name": clip(REPO, 256), "url": repo_url, "icon_url": github_icon},
    "title": clip(title, 256),
    "url": url,
    "color": color,
    "fields": fields[:25],
    "footer": footer,
    "timestamp": datetime.now(timezone.utc).isoformat(),
}
# Discord limits the combined text of an embed to 6,000 characters.
remaining = 6000 - len(embed["title"]) - len(embed["author"]["name"]) - len(footer["text"])
remaining -= sum(len(item["name"]) + len(item["value"]) for item in embed["fields"])
if description:
    embed["description"] = clip(description, min(4096, remaining))

payload = json.dumps({
    "username": "GitHub Updates",
    "avatar_url": github_icon,
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
