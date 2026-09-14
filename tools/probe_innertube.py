#!/usr/bin/env python3
"""
Пробирование Innertube API music.youtube.com без браузера.

Зачем: определить, что реально отдаёт YouTube Music в /youtubei/v1/player сегодня —
обычные форматы с `url` (их можно качать напрямую) или только SABR
(adaptiveFormats[].playerDescriptor / streamCancellationPolicy, без url).

От ответа зависит выбор архитектуры userscript'а, поэтому это не "постой плейлист",
а фундамент: если `url` ещё живы — достаточно userscript + GM_xmlhttpRequest.
Если нет — userscript обязан быть "доносом" player response для yt-dlp.

Использование:
    python3 probe_innertube.py [VIDEO_ID ...]
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request

MUSIC = "https://music.youtube.com"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)
DEFAULT_IDS = ["dQw4w9WgXcQ", "34Na4j8AVgA", "kXYiU_JCYtU"]


def http(url: str, data: bytes | None = None, headers: dict | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:  # noqa: PERF203
        return e.code, e.read()


def get_ytcfg() -> dict:
    """Вытаскиваем INNERTUBE_API_KEY / INNERTUBE_CONTEXT из HTML страницы (то же, что видит userscript)."""
    status, body = http(f"{MUSIC}/")
    html = body.decode("utf-8", "replace")
    out = {}
    m = re.search(r'"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"', html)
    if m:
        out["INNERTUBE_API_KEY"] = m.group(1)
    m = re.search(r'"INNERTUBE_API_VERSION"\s*:\s*"([^"]+)"', html)
    if m:
        out["INNERTUBE_API_VERSION"] = m.group(1)
    m = re.search(r'"INNERTUBE_CONTEXT"\s*:\s*(\{.*?\}),\s*"INNERTUBE_CONTEXT_CLIENT_NAME"', html, re.S)
    if m:
        try:
            out["INNERTUBE_CONTEXT"] = json.loads(m.group(1))
        except json.JSONDecodeError:
            out["INNERTUBE_CONTEXT_raw"] = m.group(1)[:400]
    out["_page_status"] = status
    out["_visitor"] = re.search(r'"visitorData"\s*:\s*"([^"]+)"', html)
    if out["_visitor"]:
        out["visitorData"] = out["_visitor"].group(1)
    out.pop("_visitor", None)
    return out


def player(video_id: str, cfg: dict) -> dict:
    body = {
        "context": cfg.get("INNERTUBE_CONTEXT", {}),
        "videoId": video_id,
        "racyCheckOk": True,
        "contentCheckOk": True,
        "contextfulPermissionsOk": True,
        "visitorData": cfg.get("visitorData"),
    }
    ver = cfg.get("INNERTUBE_API_VERSION") or "v1"
    req_headers = {
        "Content-Type": "application/json",
        "Origin": MUSIC,
        "Referer": f"{MUSIC}/watch?v={video_id}",
        "X-Goog-Visitor-Id": cfg.get("visitorData", ""),
        "X-Youtube-Client-Name": "67",
        "X-Youtube-Client-Version": (cfg.get("INNERTUBE_CONTEXT") or {}).get(
            "client", {}
        ).get("clientVersion", "2.20250101.00.00"),
    }
    status, raw = http(
        f"{MUSIC}/youtubei/v1/player?key={cfg.get('INNERTUBE_API_KEY','')}&prettyPrint=false",
        json.dumps(body).encode(),
        req_headers,
    )
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {"_status": status, "_raw": raw[:300].decode("utf-8", "replace")}
    data["_status"] = status
    return data


def classify(data: dict) -> dict:
    """Считаем, сколько форматов имеют прямой url, а сколько — только SABR-дескриптор."""
    res = {
        "playabilityStatus": (data.get("playabilityStatus") or {}).get("status"),
        "reason": (data.get("playabilityStatus") or {}).get("reason"),
        "formats_total": 0,
        "formats_with_url": 0,
        "sabric": 0,
        "audio_only": [],
        "signature": bool(data.get("signatureTimestamp")),
    }
    for key in ("streams", "adaptiveFormats"):
        for f in (data.get("streamingData") or {}).get(key, []) or []:
            res["formats_total"] += 1
            if f.get("url"):
                res["formats_with_url"] += 1
            if f.get("playerDescriptor") or f.get("streamCancellationPolicy") or f.get("sabrStream"):
                res["sabric"] += 1
            mime = f.get("mimeType", "")
            if mime.startswith("audio") and key == "adaptiveFormats":
                res["audio_only"].append(
                    {
                        "itag": f.get("itag"),
                        "mime": mime.split(";")[0],
                        "bitrate_kbps": (f.get("bitrate") or 0) // 1000,
                        "has_url": bool(f.get("url")),
                        "has_descriptor": bool(f.get("playerDescriptor")),
                        "quality": f.get("qualityLabel") or f.get("quality"),
                    }
                )
    return res


def main() -> int:
    ids = sys.argv[1:] or DEFAULT_IDS
    cfg = get_ytcfg()
    print("== ytcfg (то же читает userscript из страницы) ==")
    for k in ("_page_status", "INNERTUBE_API_VERSION", "visitorData"):
        v = cfg.get(k)
        print(f"  {k}: {str(v)[:80]}")
    print(f"  INNERTUBE_API_KEY: {'found' if cfg.get('INNERTUBE_API_KEY') else 'MISSING'}")
    print(f"  client: {json.dumps((cfg.get('INNERTUBE_CONTEXT') or {}).get('client', {}), ensure_ascii=False)[:300]}")

    verdicts = []
    for vid in ids:
        print(f"\n== {vid} ==")
        data = player(vid, cfg)
        info = classify(data)
        for k, v in info.items():
            if k != "audio_only":
                print(f"  {k}: {v}")
        for a in info["audio_only"]:
            print("   audio:", a)
        verdicts.append((vid, info))

    print("\n== ВЫВОД ==")
    tot_url = sum(v["formats_with_url"] for _, v in verdicts)
    tot_sabr = sum(v["sabric"] for _, v in verdicts)
    print(f"  форматов с прямым url: {tot_url}; форматов только-SABR: {tot_sabr}")
    if tot_url == 0 and tot_sabr:
        print("  => Прямых url НЕТ. Userscript-одиночка бессилен: нужен «донос» player response + yt-dlp.")
    elif tot_url:
        print("  => Прямые url ЖИВЫ. Userscript + GM_xmlhttpRequest реально работает сам по себе.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
