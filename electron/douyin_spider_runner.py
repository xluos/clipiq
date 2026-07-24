#!/usr/bin/env python3
"""ClipIQ DouYin_Spider bridge.

Reads one JSON request from stdin and writes one JSON response to stdout.
Browser/cookie collection stays in Electron; this runner only keeps the
DouYin_Spider API/signing/data-normalization capability.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import requests


DOUYIN_SHARE_URL_RE = re.compile(r"https?://[^\s]+")
DOUYIN_SHARE_URL_TRAILING_CHARS = "，。,.!！?？;；:：)）]】}\"'"
DOUYIN_WEB_HEADERS = {
    "user-agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    )
}


def log(message: str) -> None:
    print(f"[douyin-spider-runner] {message}", file=sys.stderr, flush=True)


def is_douyin_share_host(host: str) -> bool:
    host = host.lower()
    return (
        host == "iesdouyin.com"
        or host.endswith(".iesdouyin.com")
        or host == "douyin.com"
        or host.endswith(".douyin.com")
    )


def extract_douyin_share_url(value: str) -> str | None:
    for match in DOUYIN_SHARE_URL_RE.finditer(value):
        url = match.group(0).rstrip(DOUYIN_SHARE_URL_TRAILING_CHARS)
        if is_douyin_share_host(urlparse(url).netloc):
            return url
    return None


def resolve_douyin_short_url(url: str, *, timeout: float = 15.0) -> str:
    parsed = urlparse(url)
    if parsed.netloc.lower() != "v.douyin.com":
        return url
    response = requests.get(
        url,
        allow_redirects=False,
        headers=DOUYIN_WEB_HEADERS,
        stream=True,
        timeout=timeout,
    )
    try:
        return response.headers.get("location") or response.url
    finally:
        response.close()


def aweme_id_from_douyin_url(url: str) -> str | None:
    parsed = urlparse(url)
    path_parts = [part for part in parsed.path.split("/") if part]
    for marker in ("video", "note"):
        if marker in path_parts:
            index = path_parts.index(marker)
            if index + 1 < len(path_parts):
                aweme_id = path_parts[index + 1]
                if aweme_id.isdigit():
                    return aweme_id
    modal_id = (parse_qs(parsed.query).get("modal_id") or [""])[0]
    if modal_id.isdigit():
        return modal_id
    return None


def normalize_aweme_id(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("aweme_id must not be empty")
    input_value = extract_douyin_share_url(value) or value
    parsed = urlparse(input_value)
    if parsed.scheme and parsed.netloc:
        resolved_url = resolve_douyin_short_url(input_value)
        aweme_id = aweme_id_from_douyin_url(resolved_url)
        if aweme_id:
            return aweme_id
        raise ValueError(f"unsupported aweme url: {input_value}")
    aweme_id = input_value.split("?")[0].strip("/")
    if not aweme_id.isdigit():
        raise ValueError("aweme_id must be numeric")
    return aweme_id


def normalize_user_url(value: str) -> str:
    value = value.strip()
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return f"https://www.douyin.com/user/{value}"


def sec_uid_from_user_url(user_url: str) -> str:
    return user_url.rstrip("/").split("/")[-1].split("?")[0]


def extract_url_list(url_obj: dict[str, Any] | None) -> list[str]:
    if not isinstance(url_obj, dict):
        return []
    return [url for url in (url_obj.get("url_list") or []) if url]


def extract_note_image_urls(aweme: dict[str, Any]) -> list[str]:
    result: list[str] = []
    for image in aweme.get("images") or []:
        result.extend(extract_url_list(image))
    return result


def extract_comment_image_urls(comment: dict[str, Any]) -> list[str]:
    result: list[str] = []
    for image in comment.get("image_list") or []:
        result.extend(extract_url_list(image.get("origin_url") or {}))
    return result


def summarize_user(user_payload: dict[str, Any], user_url: str) -> dict[str, Any]:
    user = user_payload.get("user") or {}
    avatar = user.get("avatar_thumb") or user.get("avatar_300x300") or {}
    return {
        "sec_uid": sec_uid_from_user_url(user_url),
        "uid": user.get("uid"),
        "short_id": user.get("short_id"),
        "unique_id": user.get("unique_id"),
        "nickname": user.get("nickname"),
        "signature": user.get("signature"),
        "avatar": (avatar.get("url_list") or [""])[0],
        "following_count": user.get("following_count"),
        "follower_count": user.get("follower_count"),
        "max_follower_count": user.get("max_follower_count"),
        "total_favorited": user.get("total_favorited"),
        "aweme_count": user.get("aweme_count"),
        "ip_location": user.get("ip_location"),
        "raw_status_code": user_payload.get("status_code"),
    }


def summarize_aweme_author(aweme: dict[str, Any]) -> dict[str, Any]:
    user = aweme.get("author") or {}
    avatar = user.get("avatar_thumb") or user.get("avatar_300x300") or {}
    return {
        "sec_uid": user.get("sec_uid"),
        "uid": user.get("uid"),
        "short_id": user.get("short_id"),
        "unique_id": user.get("unique_id"),
        "nickname": user.get("nickname"),
        "signature": user.get("signature"),
        "avatar": (avatar.get("url_list") or [""])[0],
        "following_count": user.get("following_count"),
        "follower_count": user.get("follower_count"),
        "max_follower_count": user.get("max_follower_count"),
        "total_favorited": user.get("total_favorited"),
        "aweme_count": user.get("aweme_count"),
        "ip_location": user.get("ip_location"),
    }


def summarize_aweme(aweme: dict[str, Any]) -> dict[str, Any]:
    author = aweme.get("author") or {}
    statistics = aweme.get("statistics") or {}
    video = aweme.get("video") or {}
    cover = video.get("cover") or video.get("origin_cover") or {}
    play_addr = video.get("play_addr") or video.get("play_addr_h264") or {}
    aweme_id = aweme.get("aweme_id")
    return {
        "aweme_id": aweme_id,
        "aweme_url": f"https://www.douyin.com/video/{aweme_id}",
        "aweme_type": aweme.get("aweme_type"),
        "desc": aweme.get("desc"),
        "create_time": aweme.get("create_time"),
        "duration_ms": video.get("duration"),
        "author_sec_uid": author.get("sec_uid"),
        "author_uid": author.get("uid"),
        "author_nickname": author.get("nickname"),
        "play_count": statistics.get("play_count"),
        "digg_count": statistics.get("digg_count"),
        "comment_count": statistics.get("comment_count"),
        "collect_count": statistics.get("collect_count"),
        "share_count": statistics.get("share_count"),
        "cover_url": (cover.get("url_list") or [""])[0],
        "video_urls": extract_url_list(play_addr),
        "note_image_urls": extract_note_image_urls(aweme),
    }


def summarize_comment(comment: dict[str, Any], parent_comment_id: str = "0") -> dict[str, Any]:
    user = comment.get("user") or {}
    avatar = (
        user.get("avatar_medium")
        or user.get("avatar_300x300")
        or user.get("avatar_168x168")
        or user.get("avatar_thumb")
        or {}
    )
    return {
        "comment_id": comment.get("cid"),
        "parent_comment_id": parent_comment_id,
        "aweme_id": comment.get("aweme_id"),
        "content": comment.get("text"),
        "create_time": comment.get("create_time"),
        "ip_location": comment.get("ip_label"),
        "like_count": comment.get("digg_count") or 0,
        "reply_comment_total": comment.get("reply_comment_total") or 0,
        "user_id": user.get("uid"),
        "sec_uid": user.get("sec_uid"),
        "short_user_id": user.get("short_id"),
        "user_unique_id": user.get("unique_id"),
        "nickname": user.get("nickname"),
        "avatar": (avatar.get("url_list") or [""])[0],
        "picture_urls": extract_comment_image_urls(comment),
    }


def build_auth(cookie: str):
    from builder.auth import DouyinAuth

    auth = DouyinAuth()
    auth.perepare_auth(cookie, "", "")
    if "s_v_web_id" not in auth.cookie:
        raise ValueError("cookie missing s_v_web_id")
    return auth


def fetch_comments(douyin_api, auth, aweme_id: str, max_comments: int, include_replies: bool, sleep_seconds: float) -> list[dict[str, Any]]:
    video_url = f"https://www.douyin.com/video/{aweme_id}"
    cursor = "0"
    comments: list[dict[str, Any]] = []
    if max_comments <= 0:
        return comments
    while True:
        if len(comments) >= max_comments:
            break
        payload = douyin_api.get_work_out_comment(auth, video_url, cursor)
        page_comments = payload.get("comments") or []
        page_comments = page_comments[: max_comments - len(comments)]
        comments.extend(page_comments)
        if payload.get("has_more") != 1 or not page_comments:
            break
        cursor = str(payload.get("cursor") or "0")
        time.sleep(sleep_seconds)

    if not include_replies:
        return [summarize_comment(comment) for comment in comments]

    all_comments = list(comments)
    for comment in comments:
        if (comment.get("reply_comment_total") or 0) <= 0:
            continue
        try:
            replies = douyin_api.get_work_all_inner_comment(auth, comment)
        except Exception as exc:  # noqa: BLE001 - external spider errors should not abort parent comments.
            log(f"reply fetch failed cid={comment.get('cid')}: {exc}")
            continue
        for reply in replies:
            reply["_parent_comment_id"] = comment.get("cid")
        all_comments.extend(replies)
        time.sleep(sleep_seconds)
    return [
        summarize_comment(comment, parent_comment_id=comment.get("_parent_comment_id", "0"))
        for comment in all_comments
    ]


def crawl_user(payload: dict[str, Any]) -> dict[str, Any]:
    from dy_apis.douyin_api import DouyinAPI

    auth = build_auth(str(payload["cookie"]))
    user_url = normalize_user_url(str(payload["user_url"]))
    limit = max(1, int(payload.get("limit") or 20))
    max_pages = max(1, int(payload.get("max_pages") or ((limit + 17) // 18)))
    sleep_seconds = float(payload.get("sleep_seconds") or 0.8)
    max_comments = int(payload.get("max_comments_per_video") or 0)
    include_replies = bool(payload.get("include_replies"))

    user_payload = DouyinAPI.get_user_info(auth, user_url)
    user = summarize_user(user_payload, user_url)

    videos: list[dict[str, Any]] = []
    max_cursor = "0"
    for _page in range(max_pages):
        page_payload = DouyinAPI.get_user_work_info(auth, user_url, max_cursor)
        items = page_payload.get("aweme_list") or []
        has_more = page_payload.get("has_more")
        videos.extend(summarize_aweme(item) for item in items)
        log_line = (
            f"[spider-page] page={_page+1}/{max_pages} items={len(items)} "
            f"total={len(videos)} has_more={has_more} cursor={max_cursor[:20]}"
        )
        sys.stderr.write(log_line + "\n")
        if len(videos) >= limit or has_more != 1 or not items:
            break
        max_cursor = str(page_payload.get("max_cursor") or "0")
        time.sleep(sleep_seconds)

    videos = videos[:limit]
    comments_by_aweme: dict[str, list[dict[str, Any]]] = {}
    if max_comments > 0:
        for video in videos:
            aweme_id = str(video.get("aweme_id") or "")
            if not aweme_id:
                continue
            comments_by_aweme[aweme_id] = fetch_comments(
                DouyinAPI,
                auth,
                aweme_id,
                max_comments,
                include_replies,
                sleep_seconds,
            )
            time.sleep(sleep_seconds)

    return {
        "ok": True,
        "mode": "user",
        "user": user,
        "videos": videos,
        "comments_by_aweme": comments_by_aweme,
        "summary": {
            "user_url": user_url,
            "video_count": len(videos),
            "comment_count": sum(len(rows) for rows in comments_by_aweme.values()),
            "comments_with_pictures": sum(
                1
                for rows in comments_by_aweme.values()
                for row in rows
                if row.get("picture_urls")
            ),
        },
    }


def crawl_aweme(payload: dict[str, Any]) -> dict[str, Any]:
    from dy_apis.douyin_api import DouyinAPI

    auth = build_auth(str(payload["cookie"]))
    aweme_id = normalize_aweme_id(str(payload["aweme_id"]))
    video_url = f"https://www.douyin.com/video/{aweme_id}"
    max_comments = int(payload.get("max_comments_per_video") or 0)
    include_replies = bool(payload.get("include_replies"))
    sleep_seconds = float(payload.get("sleep_seconds") or 0.8)

    work_payload = DouyinAPI.get_work_info(auth, video_url)
    aweme = work_payload.get("aweme_detail") or {}
    if not aweme:
        raise RuntimeError(
            f"failed to fetch aweme detail aweme={aweme_id} status_code={work_payload.get('status_code')}"
        )
    comments = fetch_comments(DouyinAPI, auth, aweme_id, max_comments, include_replies, sleep_seconds)
    return {
        "ok": True,
        "mode": "aweme",
        "user": summarize_aweme_author(aweme),
        "video": summarize_aweme(aweme),
        "comments": comments,
        "summary": {
            "aweme_id": aweme_id,
            "aweme_url": video_url,
            "video_count": 1,
            "comment_count": len(comments),
            "comments_with_pictures": sum(1 for row in comments if row.get("picture_urls")),
        },
    }


def main() -> int:
    payload = json.load(sys.stdin)
    spider_path = Path(payload.get("spider_path") or os.environ.get("DOUYIN_SPIDER_PATH") or "").expanduser()
    if not spider_path.exists():
        raise FileNotFoundError(f"DouYin_Spider path does not exist: {spider_path}")
    sys.path.insert(0, str(spider_path.resolve()))

    op = payload.get("op")
    if op == "crawl_user":
        result = crawl_user(payload)
    elif op == "crawl_aweme":
        result = crawl_aweme(payload)
    elif op == "normalize_aweme_id":
        result = {"ok": True, "aweme_id": normalize_aweme_id(str(payload.get("aweme_id") or ""))}
    else:
        raise ValueError(f"unknown op: {op}")

    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - preserve cross-process error text.
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False), flush=True)
        raise
