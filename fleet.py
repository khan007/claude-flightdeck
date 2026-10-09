#!/usr/bin/env python3
"""fleet: list running Claude Code sessions with status, age, activity and estimated cost.

Reads Claude Code's files only; its one write is a cost cache at ~/.cache/fleet/costs.json. Sources:
  ~/.claude/sessions/<pid>.json          session registry (name, cwd, status, timestamps)
  ~/.claude/projects/*/<sessionId>.jsonl transcript (token usage per API message)

Cost is an ESTIMATE: token usage x list prices below. Edit PRICES if they change.
Usage: fleet.py [--watch [SECONDS]] [--all] [--json]
"""
import datetime
import glob
import json
import os
import sys
import time

HOME = os.path.expanduser("~")
SESSIONS = os.path.join(HOME, ".claude", "sessions")
PROJECTS = os.path.join(HOME, ".claude", "projects")

# USD per million tokens: input, output, cache read, cache write 5m, cache write 1h.
# Source: claude-api skill model table (2026-10-06). Haiku 5.5 cache read is assumed
# 0.1x input (not published in the table) and ignores its >100K-prompt surcharge.
PRICES = {
    "claude-fable-5-1": (10.0, 50.0, 0.25, 12.5, 20.0),
    "claude-opus-5-5": (4.0, 20.0, 0.20, 5.0, 8.0),
    "claude-sonnet-5-5": (2.0, 10.0, 0.20, 2.5, 4.0),
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125, 0.20),
    # Older models: cache reads assumed 0.1x input (not in the table).
    "claude-sonnet-5": (2.0, 10.0, 0.20, 2.5, 4.0),
    "claude-opus-5": (5.0, 25.0, 0.50, 6.25, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0, 0.30, 3.75, 6.0),
}

PRICES_KEY = json.dumps(PRICES, sort_keys=True) + "|fmt2"  # bump the suffix when the cache shape changes
CACHE_FILE = os.path.join(HOME, ".cache", "fleet", "costs.json")
SCAN_BUDGET_S = 10.0  # parse at most this long per run; the rest is picked up next run

# transcript path -> {size, mtime, msgs: [[epoch_ms, usd], ...], unknown, model}
_cache = {}
_cache_dirty = False
_deadline = None  # set per run; past it, unparsed files are skipped (totals are partial)
_skipped = False


def load_cache():
    global _cache
    try:
        with open(CACHE_FILE) as f:
            raw = json.load(f)
        # A price change invalidates every cached cost.
        _cache = raw["files"] if raw.get("prices") == PRICES_KEY else {}
    except (OSError, ValueError, KeyError, AttributeError):
        _cache = {}


def save_cache():
    if not _cache_dirty:
        return
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"prices": PRICES_KEY, "files": _cache}, f)
        os.replace(tmp, CACHE_FILE)
    except OSError:
        pass


def epoch_ms(ts):
    try:
        return int(datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, AttributeError):
        return 0


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def transcript_files(session_id):
    main = glob.glob(os.path.join(PROJECTS, "*", session_id + ".jsonl"))
    subs = glob.glob(os.path.join(PROJECTS, "*", session_id, "subagents", "*.jsonl"))
    return main + subs


def file_cost(path):
    """Per-message costs of one transcript, cached on disk by (size, mtime). Returns (msgs, unknown, model)."""
    global _cache_dirty, _skipped
    st = os.stat(path)
    hit = _cache.get(path)
    if hit and hit["size"] == st.st_size and hit["mtime"] == st.st_mtime:
        return hit["msgs"], hit["unknown"], hit["model"]
    if _deadline is not None and time.time() > _deadline:
        _skipped = True
        return (hit["msgs"], hit["unknown"], hit["model"]) if hit else ([], False, None)
    by_id = {}  # a message streamed over several lines repeats its id: keep the last
    with open(path, errors="replace") as f:
        for line in f:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            m = d.get("message")
            if isinstance(m, dict) and isinstance(m.get("usage"), dict):
                by_id[m.get("id") or d.get("uuid") or len(by_id)] = (m.get("model"), m["usage"], d.get("timestamp"))
    msgs, unknown, last = [], False, None
    for model, u, ts in by_id.values():
        if model == "<synthetic>":
            continue
        last = model or last
        p = PRICES.get(model)
        if not p:
            unknown = True
            continue
        cc = u.get("cache_creation") or {}
        w1h = cc.get("ephemeral_1h_input_tokens", 0)
        w5m = cc.get("ephemeral_5m_input_tokens", 0) or (
            0 if cc else u.get("cache_creation_input_tokens", 0)
        )
        c = (
            u.get("input_tokens", 0) * p[0]
            + u.get("output_tokens", 0) * p[1]
            + u.get("cache_read_input_tokens", 0) * p[2]
            + w5m * p[3]
            + w1h * p[4]
        ) / 1e6
        msgs.append([epoch_ms(ts), round(c, 6)])
    _cache[path] = {"size": st.st_size, "mtime": st.st_mtime, "msgs": msgs, "unknown": unknown, "model": last}
    _cache_dirty = True
    return msgs, unknown, last


def all_files():
    return glob.glob(os.path.join(PROJECTS, "*", "**", "*.jsonl"), recursive=True)


def midnight_ms():
    now = datetime.datetime.now().astimezone()
    return now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000


def today_total():
    """USD spent today across every transcript, subagents included."""
    start = midnight_ms()
    total = 0.0
    for p in all_files():
        try:
            if os.stat(p).st_mtime * 1000 < start:
                continue  # untouched since yesterday: nothing spent today
            msgs, _, _ = file_cost(p)
        except OSError:
            continue
        total += sum(c for ts, c in msgs if ts >= start)
    return total


def session_cost(session_id, started_ms):
    """One session's USD: (this run since its process started, today, all time, any unpriced model, last model)."""
    start = midnight_ms()
    run = today = total = 0.0
    unknown, model = False, None
    for p in transcript_files(session_id):
        try:
            msgs, u, m = file_cost(p)
        except OSError:
            continue
        for ts, c in msgs:
            total += c
            if ts >= start:
                today += c
            if ts >= started_ms:
                run += c
        unknown = unknown or u
        model = m or model
    return run, today, total, unknown, model


def short_dir(cwd):
    marker = "/.claude/worktrees/"
    wt = None
    if marker in cwd:
        cwd, wt = cwd.split(marker, 1)
        wt = wt.split("/")[0]
    elif cwd.endswith("/.claude"):
        cwd = cwd[: -len("/.claude")]
    base = os.path.basename(cwd.rstrip("/")) or cwd
    return f"{base} (wt {wt})" if wt else base


def ago(ms, now):
    s = max(0, int((now - ms) / 1000))
    if s < 10:
        return "now"
    if s < 3600:
        return f"{s // 60}m ago" if s >= 60 else f"{s}s ago"
    if s < 86400:
        return f"{s // 3600}h{(s % 3600) // 60:02d}m ago"
    return f"{s // 86400}d ago"


def age(ms, now):
    s = max(0, int((now - ms) / 1000))
    return f"{s // 3600}h{(s % 3600) // 60:02d}m" if s >= 3600 else f"{s // 60}m"


def load(show_all):
    rows = []
    for f in glob.glob(os.path.join(SESSIONS, "*.json")):
        try:
            d = json.load(open(f))
        except (OSError, ValueError):
            continue
        if not show_all and not alive(d.get("pid", -1)):
            continue
        rows.append(d)
    rows.sort(key=lambda d: d.get("startedAt", 0))
    return rows


def render(show_all, color):
    now = time.time() * 1000
    rows = load(show_all)
    paint = (lambda c, s: f"\033[{c}m{s}\033[0m") if color else (lambda c, s: s)
    out = [f"SESSIONS ({len(rows)} running)    refreshed {time.strftime('%H:%M:%S')}", ""]
    hdr = f"  {'STATUS':<9} {'NAME':<40} {'DIR':<26} {'AGE':<7} {'LAST ACTIVITY':<14} {'RUN / TODAY / ALL':>24}  MODEL"
    out.append(paint("2", hdr))
    total, any_unknown = 0.0, False
    for d in rows:
        status = d.get("status", "?")
        dot = paint("32", "● busy   ") if status == "busy" else paint("2", f"○ {status:<7}")
        name = (d.get("name") or short_dir(d.get("cwd", "")))[:40]
        run_cost, today_cost, cost, unknown, model = session_cost(d.get("sessionId", ""), d.get("startedAt", 0))
        total += cost
        any_unknown = any_unknown or unknown
        parts = [f"{run_cost:,.2f}", f"{today_cost:,.2f}", f"{cost:,.2f}"]
        cost_s = " / ".join(dict.fromkeys(parts)) + ("+" if unknown else "")  # equal values shown once
        last = ago(d.get("statusUpdatedAt") or d.get("updatedAt") or d.get("startedAt", now), now)
        mshort = (model or "?").replace("claude-", "")
        out.append(
            f"  {dot} {name:<40} "
            f"{short_dir(d.get('cwd', ''))[:26]:<26} {age(d.get('startedAt', now), now):<7} "
            f"{last:<14} {cost_s:>24}  {mshort}"
        )
    out.append("")
    out.append(
        f"  running ≈ ${total:,.2f}   today ≈ ${today_total():,.2f}"
        + ("  (partial: still scanning)" if _skipped else "")
        + ("  (+ = some usage had no known price)" if any_unknown else "")
    )
    out.append(paint("2", "  cost is an estimate from transcript token usage x list prices; excludes discounts"))
    return "\n".join(out)


def as_json(show_all):
    now = time.time() * 1000
    out = []
    for d in load(show_all):
        run_cost, today_cost, cost, unknown, model = session_cost(d.get("sessionId", ""), d.get("startedAt", 0))
        out.append({
            "id": d.get("sessionId"),
            "name": d.get("name") or short_dir(d.get("cwd", "")),
            "dir": short_dir(d.get("cwd", "")),
            "status": d.get("status", "?"),
            "entrypoint": d.get("entrypoint", ""),
            "hostId": d.get("hostSessionId", ""),
            "ageMs": int(now - d.get("startedAt", now)),
            "idleMs": int(now - (d.get("statusUpdatedAt") or d.get("updatedAt") or d.get("startedAt", now))),
            "costUsd": round(cost, 4),
            "runCostUsd": round(run_cost, 4),
            "todayCostUsd": round(today_cost, 4),
            "costIncomplete": unknown,
            "model": (model or "?").replace("claude-", ""),
        })
    return json.dumps({"sessions": out, "todayUsd": round(today_total(), 4), "partial": _skipped})


def begin_run():
    global _deadline, _skipped
    _deadline = time.time() + SCAN_BUDGET_S
    _skipped = False


def main(argv):
    show_all = "--all" in argv
    load_cache()
    if "--json" in argv:
        begin_run()
        print(as_json(show_all))
        save_cache()
        return 0
    color = sys.stdout.isatty()
    if "--watch" in argv:
        i = argv.index("--watch")
        try:
            every = float(argv[i + 1])
        except (IndexError, ValueError):
            every = 2.0
        try:
            while True:
                begin_run()
                text = render(show_all, color)
                save_cache()
                sys.stdout.write("\033[H\033[2J" + text + "\n")
                sys.stdout.flush()
                time.sleep(every)
        except KeyboardInterrupt:
            return 0
    begin_run()
    print(render(show_all, color))
    save_cache()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
