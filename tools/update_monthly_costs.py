#!/usr/bin/env python3
"""Refresh the published portfolio-cost figure from Cost Explorer.

Rewrites the marker-tagged spots in the company site and demo hub with the
prior calendar month's metered usage (RECORD_TYPE=Usage, before credits).
The dated insights post and the cards that describe it are deliberately not
touched; only the evergreen spots carry markers.

Markers look like:  <!-- auto:cost-phrase -->...<!-- /auto -->
Run from the repo root. With no flags it queries Cost Explorer; --amount and
--month override the query for offline testing.

Exit codes: 0 success (changes or no changes), 1 refused or failed. The
refusal guard is deliberate: a figure of $0.00 or one above the account's
$100 hard-cap budget means something is wrong with the month, and wrong
numbers must never reach a PR unreviewed.
"""

import argparse
import datetime
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Every marker id must appear in its file exactly this many times; the script
# fails loudly if copy edits ever drop or duplicate one.
EXPECTED_MARKERS = {
    "company-site/site/managed-aws.html": {"cost-phrase": 1},
    "company-site/site/about.html": {"cost-phrase": 1, "cost-fact": 1},
    "demo-hub/site/index.html": {"cost-hub-stat": 1},
}

TEMPLATES = {
    "cost-phrase": "metered {amount} in AWS usage in {month}",
    "cost-fact": "<strong>{amount}</strong> metered AWS usage, {month}",
    "cost-hub-stat": "<strong>{amount}</strong>metered in {month}, WAF included",
}

MARKER_RE = re.compile(r"<!-- auto:([\w-]+) -->(.*?)<!-- /auto -->", re.DOTALL)

# Sanity bounds on metered monthly usage. Zero means Cost Explorer had no
# usage data (query or timing problem); the ceiling matches the account's
# Planetek-100-Monthly-Cap budget, past which a human should be looking anyway.
USAGE_FLOOR = 0.005
USAGE_CEILING = 100.0


def previous_month(today: datetime.date) -> tuple[str, str, str]:
    """Return (start, end, label) for the calendar month before today.

    start/end are ISO dates for Cost Explorer (end exclusive); label is the
    human form used in copy, e.g. "July 2026".
    """
    first_of_this = today.replace(day=1)
    last_of_prev = first_of_this - datetime.timedelta(days=1)
    first_of_prev = last_of_prev.replace(day=1)
    return (
        first_of_prev.isoformat(),
        first_of_this.isoformat(),
        first_of_prev.strftime("%B %Y"),
    )


def fetch_costs(start: str, end: str) -> dict[str, float]:
    """Return prior-month cost by record type, e.g. {"Usage": 12.23, ...}."""
    import boto3

    ce = boto3.client("ce", region_name="us-east-1")
    response = ce.get_cost_and_usage(
        TimePeriod={"Start": start, "End": end},
        Granularity="MONTHLY",
        Metrics=["UnblendedCost"],
        GroupBy=[{"Type": "DIMENSION", "Key": "RECORD_TYPE"}],
    )
    costs: dict[str, float] = {}
    for period in response["ResultsByTime"]:
        for group in period["Groups"]:
            costs[group["Keys"][0]] = float(group["Metrics"]["UnblendedCost"]["Amount"])
    return costs


def render_file(path: Path, expected: dict[str, int], amount: str, month: str) -> bool:
    """Rewrite one file's markers in place; return True if it changed."""
    original = path.read_text(encoding="utf-8")
    seen: dict[str, int] = {}

    def substitute(match: re.Match) -> str:
        marker_id = match.group(1)
        if marker_id not in TEMPLATES:
            raise ValueError(f"{path}: unknown marker id '{marker_id}'")
        seen[marker_id] = seen.get(marker_id, 0) + 1
        body = TEMPLATES[marker_id].format(amount=amount, month=month)
        return f"<!-- auto:{marker_id} -->{body}<!-- /auto -->"

    updated = MARKER_RE.sub(substitute, original)
    if seen != expected:
        raise ValueError(f"{path}: expected markers {expected}, found {seen}")
    if updated != original:
        path.write_text(updated, encoding="utf-8")
        return True
    return False


def update_sites(amount: str, month: str) -> list[str]:
    """Apply templates to every marker file; return the changed paths."""
    changed = []
    for rel_path, expected in EXPECTED_MARKERS.items():
        if render_file(REPO_ROOT / rel_path, expected, amount, month):
            changed.append(rel_path)
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--amount", type=float, help="override metered usage (skip Cost Explorer)")
    parser.add_argument("--month", help='override month label, e.g. "July 2026"')
    args = parser.parse_args()

    start, end, month = previous_month(datetime.date.today())
    if args.month:
        month = args.month

    if args.amount is not None:
        usage, credits, net = args.amount, 0.0, args.amount
    else:
        from botocore.exceptions import BotoCoreError, ClientError

        try:
            costs = fetch_costs(start, end)
        except (ClientError, BotoCoreError) as e:
            print(f"Error querying Cost Explorer: {e}", file=sys.stderr)
            return 1
        usage = costs.get("Usage", 0.0)
        credits = costs.get("Credit", 0.0)
        net = usage + credits

    try:
        if not (USAGE_FLOOR < usage < USAGE_CEILING):
            print(
                f"REFUSING to update: metered usage for {month} is ${usage:,.2f}, "
                f"outside sane bounds (${USAGE_FLOOR}-${USAGE_CEILING}). "
                "Check Cost Explorer by hand.",
                file=sys.stderr,
            )
            return 1

        amount = f"${usage:,.2f}"
        changed = update_sites(amount, month)
    except (ValueError, OSError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    # Stdout doubles as the PR body.
    print(f"Portfolio cost figure for {month}: {amount} metered usage")
    print(f"(credits {credits:,.2f}, net out of pocket ${max(net, 0):,.2f})")
    print()
    if changed:
        print("Updated:")
        for rel_path in changed:
            print(f"- {rel_path}")
    else:
        print("No changes: published figure already current.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
