"""
デイトレスクリーナー - GitHub Actions用バッチ実行スクリプト
results.jsonを生成してdata/に保存する
"""
import requests
import pandas as pd
import yfinance as yf
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
import json
import re
import io
import os
import sys

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

# セッション（Kabutan用: トップページでCookieを先取得）
_kabutan_session = None

def get_kabutan_session():
    global _kabutan_session
    if _kabutan_session is None:
        _kabutan_session = requests.Session()
        _kabutan_session.headers.update(HEADERS)
        _kabutan_session.headers["Referer"] = "https://kabutan.jp/"
        try:
            _kabutan_session.get("https://kabutan.jp/", timeout=10)
            print("  Kabutan セッション確立")
        except Exception as e:
            print(f"  セッション確立エラー: {e}")
    return _kabutan_session

RANKING_PAGES = {
    "売買代金":   "https://kabutan.jp/warning/trading_value_ranking",
    "出来高":     "https://kabutan.jp/warning/volume_ranking",
    "値上がり率": "https://kabutan.jp/warning/?mode=2_1",
    "値下がり率": "https://kabutan.jp/warning/?mode=2_2",
    "ストップ高": "https://kabutan.jp/warning/?mode=3_1",
    "ストップ安": "https://kabutan.jp/warning/?mode=3_2",
}

# ── 株探スクレイピング ────────────────────────────────────────

def fetch_ranking(name, url):
    try:
        session = get_kabutan_session()
        r = session.get(url, timeout=15)
        r.raise_for_status()
        tables = pd.read_html(io.StringIO(r.text))
        candidates = [t for t in tables if len(t) >= 5]
        if not candidates:
            return pd.DataFrame()
        df = max(candidates, key=len)
        if len(df.columns) < 9:
            return pd.DataFrame()
        out = pd.DataFrame()
        out["コード"] = df.iloc[:, 0].astype(str).str.strip().str[:4]
        out["銘柄名"] = df.iloc[:, 1].astype(str).str.strip()
        out["市場区分"] = df.iloc[:, 2].astype(str).str.strip()
        out["終値"] = pd.to_numeric(df.iloc[:, 5], errors="coerce")
        out["前日比(%)"] = (
            df.iloc[:, 8].astype(str)
            .str.replace("%", "", regex=False)
            .str.replace("+", "", regex=False)
            .pipe(pd.to_numeric, errors="coerce")
        )
        out["_source"] = name
        out = out.dropna(subset=["コード", "終値", "前日比(%)"])
        out = out[out["コード"].str.match(r"^\w{4}$", na=False)]
        return out.reset_index(drop=True)
    except Exception as e:
        print(f"  [{name}] エラー: {e}")
        return pd.DataFrame()


def fetch_all_rankings():
    print("株探ランキング取得中...")
    frames = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(fetch_ranking, n, u): n for n, u in RANKING_PAGES.items()}
        for f in as_completed(futures):
            df = f.result()
            if not df.empty:
                frames.append(df)
    if not frames:
        return pd.DataFrame()
    merged = pd.concat(frames, ignore_index=True)
    priority = {"売買代金": 0, "出来高": 1, "値上がり率": 2, "値下がり率": 3, "ストップ高": 4, "ストップ安": 5}
    merged["_prio"] = merged["_source"].map(priority).fillna(9)
    merged = merged.sort_values("_prio").drop_duplicates(subset="コード").drop(columns=["_prio"])
    print(f"  → {len(merged)}銘柄取得")
    return merged.reset_index(drop=True)


# ── yfinance補完 ──────────────────────────────────────────────

def calc_vol_for_days(highs, lows, closes, n):
    """N日間の高値〜安値の総レンジ ÷ 起点終値
    例: 100→S高130→S高180 → (180-100)/100 = 80%
    """
    n = min(n, len(closes) - 1)
    if n < 1:
        return None
    base_close  = closes.iloc[-(n + 1)]   # N日前の終値を起点
    period_high = highs.iloc[-n:].max()
    period_low  = lows.iloc[-n:].min()
    if base_close and base_close > 0:
        return round((period_high - period_low) / base_close * 100, 2)
    return None


def enrich_yfinance(df):
    if df.empty:
        return df
    codes = df["コード"].tolist()
    tickers = [f"{c}.T" for c in codes]
    print(f"yfinance補完中 ({len(codes)}銘柄, 1ヶ月分取得)...")
    try:
        # 1ヶ月分取得して全期間分のボラを計算
        data = yf.download(tickers, period="1mo", interval="1d",
                           auto_adjust=True, progress=False, threads=True)
        if data.empty:
            return df

        vol1_map, vol3_map, vol5_map, vol20_map, tv_map = {}, {}, {}, {}, {}

        for ticker in tickers:
            code = ticker.replace(".T", "")
            try:
                if len(tickers) == 1:
                    highs = data["High"].dropna()
                    lows  = data["Low"].dropna()
                    closes = data["Close"].dropna()
                    vols  = data["Volume"].dropna()
                else:
                    highs  = data["High"][ticker].dropna()
                    lows   = data["Low"][ticker].dropna()
                    closes = data["Close"][ticker].dropna()
                    vols   = data["Volume"][ticker].dropna()

                if len(closes) < 2:
                    continue

                vol1_map[code]  = calc_vol_for_days(highs, lows, closes, 1)
                vol3_map[code]  = calc_vol_for_days(highs, lows, closes, 3)
                vol5_map[code]  = calc_vol_for_days(highs, lows, closes, 5)
                vol20_map[code] = calc_vol_for_days(highs, lows, closes, 20)
                tv_map[code]    = round(closes.iloc[-1] * vols.iloc[-1] / 1e8, 1)

            except Exception:
                pass

        df["日中ボラ(%)"]    = df["コード"].map(vol1_map)   # デフォルト当日
        df["ボラ3日"]        = df["コード"].map(vol3_map)
        df["ボラ5日"]        = df["コード"].map(vol5_map)
        df["ボラ20日"]       = df["コード"].map(vol20_map)
        df["売買代金(億)"]   = df["コード"].map(tv_map)

    except Exception as e:
        print(f"  yfinanceエラー: {e}")
        df["日中ボラ(%)"] = None
        df["売買代金(億)"] = None
    return df


# ── TDnet材料 ─────────────────────────────────────────────────

_SKIP = [
    r"ボリンジャー", r"パラボリック", r"前日に動いた銘柄", r"自己株式の取得状況",
    r"ストップ高.*引け", r"ストップ安.*引け", r"\[PTS\]", r"ETF",
    r"レーティング日報", r"出来高変化率ランキング", r"日経平均.*大引け",
]
_HOT = [
    "増収", "増益", "最高益", "上方修正", "好決算", "提携", "買収", "子会社化",
    "新製品", "受注", "株式分割", "公募増資", "TOB", "MBO",
    "NVIDIA", "AI", "量子", "半導体", "防衛", "Solana", "ブロックチェーン",
]

def _skip(t): return any(re.search(p, t) for p in _SKIP)

def _prev_biz(d):
    dt = datetime.strptime(d, "%Y%m%d")
    step = 3 if dt.weekday() == 0 else 1
    return (dt - timedelta(days=step)).strftime("%Y%m%d")

def get_generic_session():
    """TDnet・みんかぶ用汎用セッション"""
    s = requests.Session()
    s.headers.update(HEADERS)
    return s


def fetch_tdnet():
    today = datetime.now().strftime("%Y%m%d")
    dates = [today, _prev_biz(today)]
    result = {}
    for d in dates:
        for page in [1, 2]:
            url = f"https://www.release.tdnet.info/inbs/I_list_00{page}_{d}.html"
            try:
                r = requests.get(url, headers=HEADERS, timeout=10)
                if r.status_code != 200:
                    break
                r.encoding = "utf-8"
                soup = BeautifulSoup(r.text, "lxml")
                for row in soup.find_all("tr"):
                    cells = row.find_all("td")
                    if len(cells) >= 4:
                        code = re.sub(r"\D", "", cells[1].get_text(strip=True))[:4]
                        title = cells[3].get_text(strip=True)
                        a = cells[3].find("a", href=True)
                        href = a["href"] if a else ""
                        if not href:
                            doc_url = f"https://www.release.tdnet.info/inbs/I_list_001_{d}.html"
                        elif href.startswith("http"):
                            doc_url = href
                        elif href.startswith("/"):
                            doc_url = f"https://www.release.tdnet.info{href}"
                        else:
                            doc_url = f"https://www.release.tdnet.info/inbs/{href}"
                        if code and len(title) > 5:
                            result.setdefault(code, []).append(
                                {"title": title, "date": d, "url": doc_url}
                            )
            except Exception:
                pass
    return result

def best_ir(items):
    today = datetime.now().strftime("%Y%m%d")
    scored = sorted(items, key=lambda x: (
        (10 if x["date"] != today else 0) +
        sum(max(20 - i, 5) for i, kw in enumerate(_HOT) if kw in x["title"]) +
        (-50 if _skip(x["title"]) else 0)
    ), reverse=True)
    for item in scored:
        if not _skip(item["title"]):
            date_label = "前日" if item["date"] != today else "本日"
            return f"[IR/{date_label}] {item['title'][:60]}", item["url"]
    return None

def all_ir_text(items):
    today = datetime.now().strftime("%Y%m%d")
    lines = []
    for item in items[:5]:
        d = "前日" if item["date"] != today else "本日"
        lines.append(f"[{d}] {item['title'][:60]}")
    return "\n".join(lines)

def fetch_minkabu(code):
    try:
        r = requests.get(f"https://minkabu.jp/stock/{code}/news",
                         headers=HEADERS, timeout=8)
        r.encoding = "utf-8"
        soup = BeautifulSoup(r.text, "lxml")
        for a in soup.select("a[href]"):
            t = a.get_text(strip=True)
            h = a.get("href", "")
            if 20 < len(t) < 120 and not _skip(t):
                url = h if h.startswith("http") else f"https://minkabu.jp{h}"
                if code in t or re.search(r"[＜<（(]", t):
                    return f"[みんかぶ] {t[:60]}", url
        for a in soup.select("a[href]"):
            t = a.get_text(strip=True)
            h = a.get("href", "")
            if 20 < len(t) < 120 and not _skip(t):
                url = h if h.startswith("http") else f"https://minkabu.jp{h}"
                return f"[みんかぶ] {t[:60]}", url
    except Exception:
        pass
    return None

def fetch_kabutan_news(code):
    try:
        r = requests.get(f"https://kabutan.jp/stock/news?code={code}",
                         headers=HEADERS, timeout=8)
        r.encoding = "utf-8"
        soup = BeautifulSoup(r.text, "lxml")
        for td in soup.find_all("td", class_="news_time"):
            row = td.parent
            for c in row.find_all("td"):
                if "news_time" in c.get("class", []):
                    continue
                a = c.find("a", href=True)
                t = c.get_text(strip=True)
                if len(t) > 8 and not _skip(t):
                    href = a["href"] if a else ""
                    url = href if href.startswith("http") else f"https://kabutan.jp{href}"
                    return f"[株探] {t[:60]}", url
    except Exception:
        pass
    return None

def fetch_materials(codes):
    print(f"材料取得中 ({len(codes)}銘柄)...")
    tdnet = fetch_tdnet()
    results = {}
    today = datetime.now().strftime("%Y%m%d")

    # TDnet一括
    for code in codes:
        items = tdnet.get(code, [])
        b = best_ir(items)
        if b:
            results[code] = {
                "text": b[0], "url": b[1],
                "all_ir": all_ir_text(items)
            }

    # 残りをみんかぶ→株探
    remaining = [c for c in codes if c not in results]
    def fetch_one(code):
        m = fetch_minkabu(code)
        if m: return code, {"text": m[0], "url": m[1], "all_ir": ""}
        k = fetch_kabutan_news(code)
        if k: return code, {"text": k[0], "url": k[1], "all_ir": ""}
        return code, None

    with ThreadPoolExecutor(max_workers=8) as ex:
        for code, mat in ex.map(lambda c: fetch_one(c), remaining):
            if mat:
                results[code] = mat

    print(f"  → 材料取得: {len(results)}件")
    return results


# ── メイン ───────────────────────────────────────────────────

def main():
    start = datetime.now()
    print(f"=== デイトレスクリーナー バッチ実行 {start.strftime('%Y/%m/%d %H:%M')} ===")

    df = fetch_all_rankings()
    if df.empty:
        print("データ取得失敗")
        sys.exit(1)

    df = enrich_yfinance(df)
    materials = fetch_materials(df["コード"].tolist())

    # JSONシリアライズ
    stocks = []
    for _, row in df.iterrows():
        code = str(row.get("コード", ""))
        mat = materials.get(code, {})
        def safe_float(val):
            return float(val) if pd.notna(val) else None

        stocks.append({
            "code":          code,
            "name":          str(row.get("銘柄名", "")),
            "market":        str(row.get("市場区分", "")),
            "close":         safe_float(row.get("終値")),
            "change_pct":    safe_float(row.get("前日比(%)")),
            "intraday_vol":  safe_float(row.get("日中ボラ(%)")),
            "vol_3d":        safe_float(row.get("ボラ3日")),
            "vol_5d":        safe_float(row.get("ボラ5日")),
            "vol_20d":       safe_float(row.get("ボラ20日")),
            "trading_value": safe_float(row.get("売買代金(億)")),
            "source":        str(row.get("_source", "")),
            "material_text": mat.get("text", ""),
            "material_url":  mat.get("url", ""),
            "material_all":  mat.get("all_ir", ""),
        })

    # 日中ボラ降順ソート
    stocks.sort(key=lambda x: x.get("intraday_vol") or 0, reverse=True)

    now_jst = datetime.utcnow() + timedelta(hours=9)
    output = {
        "updated_at": now_jst.strftime("%Y-%m-%dT%H:%M:00+09:00"),
        "updated_at_display": now_jst.strftime("%m/%d %H:%M"),
        "count": len(stocks),
        "stocks": stocks,
    }

    out_path = os.path.join(os.path.dirname(__file__), "..", "data", "results.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    elapsed = (datetime.now() - start).seconds
    print(f"=== 完了 ({elapsed}秒) → data/results.json ({len(stocks)}銘柄) ===")


if __name__ == "__main__":
    main()
