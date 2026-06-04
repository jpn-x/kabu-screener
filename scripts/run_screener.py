"""
デイトレスクリーナー - GitHub Actions バッチ実行
JPX上場全銘柄 + yfinance で完全自前スクリーニング（外部サイト不要）
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
import time

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "ja,en-US;q=0.9",
}

JPX_LIST_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls"
CACHE_PATH   = os.path.join(os.path.dirname(__file__), "..", "data", "jpx_list_cache.pkl")


# ── JPX銘柄リスト取得 ─────────────────────────────────────────

def load_jpx_list() -> pd.DataFrame:
    """JPX上場銘柄一覧を取得（キャッシュ1日）"""
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)

    if os.path.exists(CACHE_PATH):
        mtime = datetime.fromtimestamp(os.path.getmtime(CACHE_PATH))
        if datetime.now() - mtime < timedelta(hours=20):
            df = pd.read_pickle(CACHE_PATH)
            print(f"  JPXリスト: キャッシュ読み込み ({len(df)}銘柄)")
            return df

    print("  JPXリスト: 取得中...")
    r = requests.get(JPX_LIST_URL, headers=HEADERS, timeout=30)
    r.raise_for_status()
    df = pd.read_excel(io.BytesIO(r.content), header=0)

    # 列名を整理
    cols = df.columns.tolist()
    code_col   = cols[1]   # コード
    market_col = cols[3]   # 市場・商品区分
    sector_col = cols[6]   # 17業種区分  (index 5 or 6)
    name_col   = cols[2]   # 銘柄名

    df = df.rename(columns={
        code_col:   "コード",
        name_col:   "銘柄名",
        market_col: "市場区分",
    })
    if len(cols) > 6:
        df = df.rename(columns={cols[5]: "業種"})

    df["コード"] = df["コード"].astype(str).str.zfill(4)
    df["市場区分"] = df["市場区分"].astype(str)

    # 普通株のみ（ETF/REIT等を除外）
    df = df[df["市場区分"].str.contains("プライム|スタンダード|グロース", na=False)]
    df = df.reset_index(drop=True)

    df.to_pickle(CACHE_PATH)
    print(f"  JPXリスト: 取得完了 ({len(df)}銘柄)")
    return df


# ── yfinance 一括取得＆スクリーニング ──────────────────────────

def calc_vol_range(highs, lows, closes, n):
    """N日間の高値〜安値レンジ÷起点終値"""
    n = min(n, len(closes) - 1)
    if n < 1:
        return None
    base  = closes.iloc[-(n + 1)]
    ph    = highs.iloc[-n:].max()
    pl    = lows.iloc[-n:].min()
    return round((ph - pl) / base * 100, 2) if base and base > 0 else None


def fetch_and_screen(codes: list[str], chunk_size=500) -> pd.DataFrame:
    """
    yfinanceで全銘柄を chunk_size ずつ分割取得し、
    アクティブな銘柄（売買代金・変動率上位）を返す
    """
    all_rows = []
    chunks = [codes[i:i+chunk_size] for i in range(0, len(codes), chunk_size)]

    for i, chunk in enumerate(chunks):
        tickers = [f"{c}.T" for c in chunk]
        print(f"  yfinance取得中... chunk {i+1}/{len(chunks)} ({len(chunk)}銘柄)")
        try:
            data = yf.download(
                tickers, period="1mo", interval="1d",
                auto_adjust=True, progress=False, threads=True
            )
            if data.empty:
                continue

            for ticker in tickers:
                code = ticker.replace(".T", "")
                try:
                    if len(tickers) == 1:
                        closes = data["Close"].dropna()
                        highs  = data["High"].dropna()
                        lows   = data["Low"].dropna()
                        vols   = data["Volume"].dropna()
                    else:
                        closes = data["Close"][ticker].dropna()
                        highs  = data["High"][ticker].dropna()
                        lows   = data["Low"][ticker].dropna()
                        vols   = data["Volume"][ticker].dropna()

                    if len(closes) < 2:
                        continue

                    close  = closes.iloc[-1]
                    prev   = closes.iloc[-2]
                    volume = vols.iloc[-1]

                    if pd.isna(close) or close == 0 or pd.isna(volume):
                        continue

                    change_pct = round((close - prev) / prev * 100, 2) if prev else 0
                    tv         = round(close * volume / 1e8, 1)

                    # 売買代金0.3億未満は除外（非アクティブ）
                    if tv < 0.3:
                        continue

                    all_rows.append({
                        "コード":       code,
                        "終値":         float(close),
                        "前日比(%)":    change_pct,
                        "日中ボラ(%)":  calc_vol_range(highs, lows, closes, 1),
                        "ボラ3日":      calc_vol_range(highs, lows, closes, 3),
                        "ボラ5日":      calc_vol_range(highs, lows, closes, 5),
                        "ボラ20日":     calc_vol_range(highs, lows, closes, 20),
                        "売買代金(億)": tv,
                        "出来高":       int(volume),
                    })
                except Exception:
                    pass
        except Exception as e:
            print(f"  chunk {i+1} エラー: {e}")

        if i < len(chunks) - 1:
            time.sleep(1)  # レート制限対策

    df = pd.DataFrame(all_rows) if all_rows else pd.DataFrame()
    print(f"  yfinance: アクティブ銘柄 {len(df)}件")
    return df


def get_source_label(row) -> str:
    """ランキング元ラベルを付与"""
    chg = abs(row.get("前日比(%)", 0) or 0)
    tv  = row.get("売買代金(億)", 0) or 0
    vol = row.get("日中ボラ(%)", 0) or 0
    if chg >= 15:
        return "値上がり率" if row.get("前日比(%)", 0) > 0 else "値下がり率"
    if tv >= 100:
        return "売買代金"
    if vol >= 10:
        return "高ボラ"
    return "出来高"


# ── 材料取得（変更なし） ──────────────────────────────────────

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

def fetch_tdnet():
    today = datetime.now().strftime("%Y%m%d")
    dates = [today, _prev_biz(today)]
    result = {}
    s = requests.Session()
    s.headers.update(HEADERS)
    for d in dates:
        for page in [1, 2]:
            url = f"https://www.release.tdnet.info/inbs/I_list_00{page}_{d}.html"
            try:
                r = s.get(url, timeout=10)
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
        sum(max(20-i,5) for i,kw in enumerate(_HOT) if kw in x["title"]) +
        (-50 if _skip(x["title"]) else 0)
    ), reverse=True)
    for item in scored:
        if not _skip(item["title"]):
            dl = "前日" if item["date"] != today else "本日"
            return f"[IR/{dl}] {item['title'][:60]}", item["url"]
    return None

def all_ir_text(items):
    today = datetime.now().strftime("%Y%m%d")
    return "\n".join(
        f"[{'前日' if x['date']!=today else '本日'}] {x['title'][:60]}"
        for x in items[:5]
    )

def fetch_minkabu(code):
    try:
        s = requests.Session()
        s.headers.update(HEADERS)
        r = s.get(f"https://minkabu.jp/stock/{code}/news", timeout=8)
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
        s = requests.Session()
        s.headers.update(HEADERS)
        s.headers["Referer"] = "https://kabutan.jp/"
        s.get("https://kabutan.jp/", timeout=5)
        r = s.get(f"https://kabutan.jp/stock/news?code={code}", timeout=8)
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

def fetch_materials(codes, progress_callback=None):
    print(f"材料取得中 ({len(codes)}銘柄)...")
    tdnet = fetch_tdnet()
    results = {}
    today = datetime.now().strftime("%Y%m%d")

    for code in codes:
        items = tdnet.get(code, [])
        b = best_ir(items)
        if b:
            results[code] = {"text": b[0], "url": b[1], "all_ir": all_ir_text(items)}

    remaining = [c for c in codes if c not in results]
    def fetch_one(code):
        m = fetch_minkabu(code)
        if m: return code, {"text": m[0], "url": m[1], "all_ir": ""}
        k = fetch_kabutan_news(code)
        if k: return code, {"text": k[0], "url": k[1], "all_ir": ""}
        return code, None

    with ThreadPoolExecutor(max_workers=6) as ex:
        for code, mat in ex.map(fetch_one, remaining):
            if mat:
                results[code] = mat

    print(f"  材料: {len(results)}件")
    return results


# ── メイン ───────────────────────────────────────────────────

def main():
    start = datetime.now()
    print(f"=== デイトレスクリーナー {start.strftime('%Y/%m/%d %H:%M')} JST ===")

    # 1. JPX銘柄リスト取得
    jpx = load_jpx_list()
    codes = jpx["コード"].tolist()

    # 2. yfinanceで全銘柄スクリーニング
    price_df = fetch_and_screen(codes, chunk_size=500)
    if price_df.empty:
        print("データ取得失敗")
        sys.exit(1)

    # 3. 銘柄名・市場・業種マージ
    name_cols = ["コード"] + [c for c in ["銘柄名","市場区分","業種"] if c in jpx.columns]
    merged = price_df.merge(jpx[name_cols], on="コード", how="left")

    # 4. ランキング元ラベル付与
    merged["_source"] = merged.apply(get_source_label, axis=1)

    # 5. 活発な銘柄上位150件を素材として材料取得
    # 売買代金上位50 + |前日比|上位50 + ボラ上位50 を合算してユニーク化
    top_tv   = merged.nlargest(50, "売買代金(億)")["コード"].tolist()
    top_chg  = merged.reindex(merged["前日比(%)"].abs().nlargest(50).index)["コード"].tolist()
    top_vol  = merged.nlargest(50, "日中ボラ(%)")["コード"].tolist()
    candidate_codes = list(dict.fromkeys(top_tv + top_chg + top_vol))  # 重複排除・順序保持

    materials = fetch_materials(candidate_codes)

    # 6. JSON出力
    def sf(v):
        return float(v) if pd.notna(v) else None

    stocks = []
    for _, row in merged.iterrows():
        code = str(row["コード"])
        mat  = materials.get(code, {})
        stocks.append({
            "code":          code,
            "name":          str(row.get("銘柄名", "")),
            "market":        str(row.get("市場区分", "")),
            "close":         sf(row.get("終値")),
            "change_pct":    sf(row.get("前日比(%)")),
            "intraday_vol":  sf(row.get("日中ボラ(%)")),
            "vol_3d":        sf(row.get("ボラ3日")),
            "vol_5d":        sf(row.get("ボラ5日")),
            "vol_20d":       sf(row.get("ボラ20日")),
            "trading_value": sf(row.get("売買代金(億)")),
            "source":        str(row.get("_source", "")),
            "material_text": mat.get("text", ""),
            "material_url":  mat.get("url", ""),
            "material_all":  mat.get("all_ir", ""),
        })

    # ボラ降順
    stocks.sort(key=lambda x: x.get("intraday_vol") or 0, reverse=True)

    now_jst = datetime.utcnow() + timedelta(hours=9)
    output = {
        "updated_at":         now_jst.strftime("%Y-%m-%dT%H:%M:00+09:00"),
        "updated_at_display": now_jst.strftime("%m/%d %H:%M"),
        "count":              len(stocks),
        "stocks":             stocks,
    }

    out_path = os.path.join(os.path.dirname(__file__), "..", "data", "results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    elapsed = int((datetime.now() - start).total_seconds())
    print(f"=== 完了 {elapsed}秒 → {len(stocks)}銘柄 ===")


if __name__ == "__main__":
    main()
