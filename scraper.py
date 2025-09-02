#!/usr/bin/env python3
"""
Hacker News Scraper (Python)
- Fetches https://news.ycombinator.com/
- Parses posts and stores them into SQLite (hs.db) at project root
- UPSERT by HN id
- If fetch fails (offline), falls back to parsing local dummy.html in project root

Usage:
  ./.venv/bin/python scraper.py

Requirements:
  - Python 3.8+
  - requests, beautifulsoup4 installed in the existing .venv
"""
from __future__ import annotations

import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "hs.db"
DUMMY_HTML = ROOT / "dummy.html"
HN_URL = "https://news.ycombinator.com/"
UA = "Mozilla/5.0 (compatible; hn-scraper/1.0; +https://news.ycombinator.com/)"


def ensure_db(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS posts (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          url TEXT,
          user TEXT,
          points INTEGER DEFAULT 0,
          time_posted TEXT,
          scraped_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_posts_time ON posts(time_posted);
        """
    )


def get_html() -> str:
    try:
        resp = requests.get(
            HN_URL,
            headers={"User-Agent": UA},
            timeout=15,
        )
        resp.raise_for_status()
        resp.encoding = resp.apparent_encoding or "utf-8"
        return resp.text
    except Exception as e:
        # Fallback to local dummy file for offline/dev
        sys.stderr.write(f"Fetch failed ({e}). Falling back to dummy.html\n")
        return DUMMY_HTML.read_text(encoding="utf-8")


def parse_posts(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    posts: list[dict] = []

    for row in soup.select("tr.athing"):
        # id
        id_attr = row.get("id")
        try:
            post_id = int(id_attr) if id_attr is not None else None
        except ValueError:
            post_id = None

        # title and url (new markup span.titleline a; fallback a.storylink)
        anchor = row.select_one("span.titleline a") or row.select_one("a.storylink")
        title = (anchor.get_text(strip=True) if anchor else "")
        url = (anchor.get("href") if anchor else "") or ""
        if url.startswith("item?id="):
            url = f"https://news.ycombinator.com/{url}"

        # subtext on next <tr>
        subtext_td = None
        sib = row.find_next_sibling()
        while sib is not None:
            if getattr(sib, "name", None) == "tr":
                subtext_td = sib.select_one("td.subtext")
                break
            sib = sib.find_next_sibling()

        user = None
        points = 0
        time_posted = None
        if subtext_td:
            user_el = subtext_td.select_one("a.hnuser")
            user = user_el.get_text(strip=True) if user_el else None

            score_el = subtext_td.select_one("span.score")
            if score_el:
                # extract first integer
                digits = "".join(ch for ch in score_el.get_text() if ch.isdigit())
                points = int(digits) if digits else 0

            age_el = subtext_td.select_one("span.age")
            # prefer absolute timestamp in title attribute (UTC ISO)
            time_posted = age_el.get("title") if age_el else None

        if not isinstance(post_id, int) or post_id <= 0 or not title:
            continue

        posts.append(
            {
                "id": post_id,
                "title": title,
                "url": url,
                "user": user,
                "points": points,
                "time_posted": time_posted,
            }
        )

    return posts


def upsert_posts(conn: sqlite3.Connection, posts: list[dict]) -> None:
    now_iso = datetime.now(timezone.utc).isoformat()
    sql = (
        """
        INSERT INTO posts (id, title, url, user, points, time_posted, scraped_at)
        VALUES (:id, :title, :url, :user, :points, :time_posted, :scraped_at)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          url = excluded.url,
          user = excluded.user,
          points = excluded.points,
          time_posted = COALESCE(excluded.time_posted, posts.time_posted),
          scraped_at = excluded.scraped_at
        """
    )
    with conn:
        for row in posts:
            conn.execute(sql, {**row, "scraped_at": now_iso})


def main() -> int:
    try:
        conn = sqlite3.connect(DB_PATH)
        ensure_db(conn)
        html = get_html()
        posts = parse_posts(html)
        if not posts:
            sys.stderr.write("No posts parsed. Check selectors or HTML source.\n")
        upsert_posts(conn, posts)
        print(f"Upserted {len(posts)} posts at {datetime.now(timezone.utc).isoformat()}")
        conn.close()
        return 0
    except Exception as e:
        sys.stderr.write(f"Scrape failed: {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
