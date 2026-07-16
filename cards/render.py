"""HORUS card renderer - data-driven port of the validated card_v4 design.

Reads one JSON job on stdin, writes a PNG, prints the output path.
Design system: "Dramatic dark + spotlight gold", Fira Code / Fira Sans.

Job shape (all texts arrive already translated):
{
  "out": "/abs/path.png",
  "kind": "big" | "mini" | "duel" | "fulltime" | "shootout",
  "badge": "GOAL", "badgeColor": "gold", "minute": 83, "sub": "SHOOTOUT",
  "live": true,
  "home": {"name": "Argentina", "color": [117,170,219], "logo": "/abs.png"},
  "away": {"name": "Egypt",     "color": [206,17,38],   "logo": "/abs.png"},
  "score": [3, 2], "hlHome": true, "hlAway": false,
  "player": {"name": "Julian Alvarez", "photo": "/abs.png", "halo": true, "desat": 0},
  "redCardIcon": false,
  "stats": [["Win probability", "41% -> 62%", "gold"], ...],   # 2-3 boxes
  "quote": {"author": "El Fuego", "text": "...", "accent": "gold"},
  "verified": "seq 1847 - statKey 1",           # fulltime green banner
  "title": "...", "subtitle": "...",            # mini cards
  "statLabel": "Corners", "statVal": "5 - 1", "statColor": "gold",  # mini
  "centerText": "KICK-OFF IN 01:47:12",         # duel countdown / note
  "note": "Market makes Germany 61% favourites",# duel bottom strip
  "shootout": {"rows": [["NED", "xxo?-"], ["MAR", "xoxx-"]]}
}
"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")

BG, SURFACE, MUTED = (15, 15, 35), (27, 27, 48), (39, 39, 59)
FG, MUTED_FG = (248, 250, 252), (148, 163, 184)
COLORS = {
    "gold": (240, 180, 41), "gold_deep": (202, 138, 4),
    "red": (239, 68, 68), "red_dark": (127, 29, 29),
    "orange": (245, 158, 11), "green": (45, 212, 168),
    "kick_green": (16, 185, 129), "cyan": (34, 211, 238),
    "violet": (139, 92, 246), "yellow": (234, 179, 8),
    "muted": MUTED, "muted_fg": MUTED_FG, "fg": FG, "bg": BG,
    "steel": (56, 89, 138),
}
def col(v, default=FG):
    if isinstance(v, (list, tuple)): return tuple(v)
    return COLORS.get(v, default)

W, H, MH, BAND, PADX = 800, 500, 280, 10, 36
LEFT, RIGHT = BAND + PADX, W - BAND - PADX

def mono(size):
    f = ImageFont.truetype(os.path.join(ASSETS, "FiraCode-Bold.ttf"), size)
    try: f.set_variation_by_name("Bold")
    except Exception: pass
    return f
def sans(weight, size):
    return ImageFont.truetype(os.path.join(ASSETS, f"FiraSans-{weight}.ttf"), size)

F_LABEL, F_BRAND, F_QUOTE = sans("Medium", 12), sans("Medium", 14), sans("Regular", 16)
F_BADGE, F_TEAM, F_PLAYER = sans("Bold", 18), sans("Bold", 18), sans("Bold", 24)
F_STAT, F_SCORE, F_MIN, F_SUB = mono(32), mono(64), mono(18), mono(12)

def text_w(d, t, f):
    b = d.textbbox((0, 0), t, font=f); return b[2] - b[0]

def load_path(p, size=None):
    if not p or not os.path.exists(p): return None
    try:
        im = Image.open(p).convert("RGBA")
        if size: im = im.resize((size, size), Image.LANCZOS)
        return im
    except Exception:
        return None

def load_crest(p, size):
    """Team badge: center-crop the flag to a circle so it reads as a crest."""
    if not p or not os.path.exists(p): return None
    try:
        im = Image.open(p).convert("RGBA")
        side = min(im.size)
        left, top = (im.width - side) // 2, (im.height - side) // 2
        im = im.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, size, size], fill=255)
        im.putalpha(mask)
        ring = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(ring).ellipse([0, 0, size - 1, size - 1], outline=MUTED_FG + (160,), width=2)
        im.alpha_composite(ring)
        return im
    except Exception:
        return None

def circle_photo(path, size, desat=0):
    im = load_path(path, size)
    if im is None: return None
    if desat: im = ImageEnhance.Color(im).enhance(1 - desat)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, size, size], fill=255)
    im.putalpha(mask)
    return im

def base(job, height=H):
    img = Image.new("RGBA", (W, height), BG + (255,))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, BAND - 1, height], fill=col(job["home"].get("color"), MUTED))
    d.rectangle([W - BAND, 0, W, height], fill=col(job["away"].get("color"), MUTED))
    return img, d

def badge_row(d, job, y=22, h=38):
    label = job.get("badge", "")
    color = col(job.get("badgeColor", "gold"))
    fg = col(job.get("badgeFg", "bg"))
    w = text_w(d, label, F_BADGE) + 32
    d.rounded_rectangle([LEFT, y, LEFT + w, y + h], radius=6, fill=color)
    d.text((LEFT + 16, y + (h - 22) // 2), label, fill=fg, font=F_BADGE)
    x = LEFT + w + 12
    if job.get("sub"):
        sw = text_w(d, job["sub"], F_SUB) + 20
        d.rounded_rectangle([x, y + 4, x + sw, y + h - 4], radius=6, fill=MUTED)
        d.text((x + 10, y + 11), job["sub"], fill=MUTED_FG, font=F_SUB)
        x += sw + 12
    if job.get("minute") is not None:
        mt = f"{job['minute']}'"
        mw = text_w(d, mt, F_MIN) + 24
        d.rounded_rectangle([x, y + 2, x + mw, y + h - 2], radius=6, outline=MUTED, width=2)
        d.text((x + 12, y + 8), mt, fill=FG, font=F_MIN)
    if job.get("live", True):
        lx = RIGHT - 64
        d.ellipse([lx, y + 12, lx + 10, y + 22], fill=(255, 59, 59))
        d.text((lx + 16, y + 9), "LIVE", fill=(255, 59, 59), font=sans("Bold", 14))

def score_row(img, d, y, job, logo=44):
    home, away = job["home"], job["away"]
    hs, as_ = job.get("score", ["", ""])
    hlogo, alogo = load_crest(home.get("logo"), logo), load_crest(away.get("logo"), logo)
    if hlogo: img.paste(hlogo, (LEFT, y), hlogo)
    d.text((LEFT + logo + 12, y + logo // 2 - 11), home["name"].upper()[:14], fill=FG, font=F_TEAM)
    an = away["name"].upper()[:14]
    aw = text_w(d, an, F_TEAM)
    ax = RIGHT - aw
    if alogo: img.paste(alogo, (ax - logo - 12, y), alogo)
    d.text((ax, y + logo // 2 - 11), an, fill=FG, font=F_TEAM)
    cx = W // 2
    hst, ast = str(hs), str(as_)
    gold = COLORS["gold"]
    d.text((cx - 44 - text_w(d, hst, F_SCORE), y - 18), hst, fill=gold if job.get("hlHome") else FG, font=F_SCORE)
    d.line([(cx - 20, y + 22), (cx + 20, y + 22)], fill=MUTED_FG, width=5)
    d.text((cx + 44, y - 18), ast, fill=gold if job.get("hlAway") else FG, font=F_SCORE)

def fit_font(d, text, max_w, sizes=(32, 26, 22, 18, 15)):
    """Largest mono size whose rendering fits max_w — values never overflow."""
    for s in sizes:
        f = mono(s)
        if text_w(d, text, f) <= max_w: return f
    return mono(sizes[-1])

def stat_boxes(d, y, stats):
    n = len(stats)
    if not n: return
    gap = 16
    bw = (RIGHT - LEFT - gap * (n - 1)) // n
    for i, (label, val, color) in enumerate(stats):
        x = LEFT + i * (bw + gap)
        d.rounded_rectangle([x, y, x + bw, y + 72], radius=8, fill=SURFACE, outline=MUTED, width=1)
        d.text((x + 14, y + 10), str(label).upper()[:24], fill=MUTED_FG, font=F_LABEL)
        vf = fit_font(d, str(val), bw - 28)
        # vertically center smaller values in the same slot as the 32px ones
        d.text((x + 14, y + 30 + (32 - vf.size) // 2), str(val), fill=col(color), font=vf)

def quote_strip(d, y, q):
    accent = col(q.get("accent", "gold"))
    d.rounded_rectangle([LEFT, y, RIGHT, y + 78], radius=8, fill=SURFACE)
    d.rounded_rectangle([LEFT, y, LEFT + 4, y + 78], radius=2, fill=accent)
    d.text((LEFT + 20, y + 12), q.get("author", "HORUS").upper(), fill=accent, font=sans("Bold", 13))
    words, lines, cur = ('"' + q.get("text", "") + '"').split(), [], ""
    for w_ in words:
        t = f"{cur} {w_}".strip()
        if len(t) <= 72: cur = t
        else: lines.append(cur); cur = w_
    lines.append(cur)
    for i, line in enumerate(lines[:2]):
        d.text((LEFT + 20, y + 34 + i * 21), line, fill=MUTED_FG, font=F_QUOTE)

def footer(d, height=H):
    y = height - 42
    d.line([(LEFT, y - 8), (RIGHT, y - 8)], fill=MUTED, width=1)
    d.text((LEFT, y), "HORUS", fill=MUTED_FG, font=F_BRAND)
    tail = [("Powered by ", MUTED_FG), ("TxLINE", COLORS["gold_deep"]), (" on Solana", MUTED_FG)]
    tw = sum(text_w(d, t, F_BRAND) for t, _ in tail)
    x = RIGHT - tw
    for t, c in tail:
        d.text((x, y), t, fill=c, font=F_BRAND); x += text_w(d, t, F_BRAND)

def photo_block(img, d, job):
    p = job.get("player") or {}
    ring = col(job.get("badgeColor", "gold"))
    size = 110
    x, y = RIGHT - size, 74
    if p.get("halo"):
        glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([x - 26, y - 26, x + size + 26, y + size + 26], fill=ring + (90,))
        glow = glow.filter(ImageFilter.GaussianBlur(18))
        img.alpha_composite(glow)
    ph = circle_photo(p.get("photo"), size, desat=p.get("desat", 0))
    if ph:
        d.ellipse([x - 4, y - 4, x + size + 4, y + size + 4], outline=ring, width=4)
        img.paste(ph, (x, y), ph)
    elif p.get("name"):
        d.ellipse([x, y, x + size, y + size], fill=SURFACE, outline=ring, width=4)
        init = "".join(w[0] for w in p["name"].split()[:2]).upper()
        f = sans("Bold", 34)
        d.text((x + (size - text_w(d, init, f)) // 2, y + size // 2 - 22), init, fill=MUTED_FG, font=f)
    if p.get("name"):
        d.text((LEFT, 92), p["name"].upper()[:26], fill=FG, font=F_PLAYER)
        d.line([(LEFT, 128), (LEFT + 100, 128)], fill=ring, width=3)
    # brandished card icon beside the photo — red or yellow
    icon_col = COLORS["red"] if job.get("redCardIcon") else (COLORS["yellow"] if job.get("yellowCardIcon") else None)
    if icon_col:
        card = Image.new("RGBA", (24, 34), icon_col + (255,))
        card = card.rotate(8, expand=True, resample=Image.BICUBIC)
        img.paste(card, (x - 44, y + 30), card)

# ---------------- card kinds ----------------
def render_big(job):
    img, d = base(job)
    badge_row(d, job)
    if job.get("player") is not None: photo_block(img, d, job)
    elif job.get("centerText"):
        f = sans("Bold", 30)
        d.text(((W - text_w(d, job["centerText"], f)) // 2, 96), job["centerText"], fill=col(job.get("badgeColor", "cyan")), font=f)
    score_row(img, d, 208, job)
    stat_boxes(d, 288, job.get("stats", []))
    if job.get("quote"): quote_strip(d, 364, job["quote"])
    footer(d)
    return img

def render_mini(job):
    img, d = base(job, MH)
    badge_row(d, {**job, "sub": None}, y=18, h=34)
    p = job.get("player") or {}
    if p.get("photo") or p.get("name"):
        size = 72
        px, py = RIGHT - size, 66
        ph = circle_photo(p.get("photo"), size)
        ring = col(job.get("badgeColor", "gold"))
        if ph:
            d.ellipse([px - 3, py - 3, px + size + 3, py + size + 3], outline=ring, width=3)
            img.paste(ph, (px, py), ph)
    d.text((LEFT, 72), job.get("title", "").upper()[:30], fill=FG, font=sans("Bold", 22))
    d.text((LEFT, 104), job.get("subtitle", "")[:80], fill=MUTED_FG, font=F_QUOTE)
    yb = 168
    home, away = job["home"], job["away"]
    hs, as_ = job.get("score", ["", ""])
    hlogo, alogo = load_crest(home.get("logo"), 30), load_crest(away.get("logo"), 30)
    if hlogo: img.paste(hlogo, (LEFT, yb), hlogo)
    sc = f"{hs} - {as_}"
    d.text((LEFT + 40, yb + 2), home["name"][:3].upper(), fill=FG, font=F_TEAM)
    d.text((LEFT + 96, yb - 4), sc, fill=FG, font=mono(30))
    aw_x = LEFT + 96 + text_w(d, sc, mono(30)) + 16
    d.text((aw_x, yb + 2), away["name"][:3].upper(), fill=FG, font=F_TEAM)
    if alogo: img.paste(alogo, (aw_x + 58, yb), alogo)
    if job.get("statLabel"):
        bw = 240
        d.rounded_rectangle([RIGHT - bw, yb - 8, RIGHT, yb + 44], radius=8, fill=SURFACE, outline=MUTED, width=1)
        d.text((RIGHT - bw + 14, yb - 1), job["statLabel"].upper()[:22], fill=MUTED_FG, font=F_LABEL)
        d.text((RIGHT - bw + 14, yb + 14), str(job.get("statVal", "")), fill=col(job.get("statColor", "fg")), font=mono(22))
    fy = MH - 34
    d.line([(LEFT, fy - 6), (RIGHT, fy - 6)], fill=MUTED, width=1)
    d.text((LEFT, fy), "HORUS", fill=MUTED_FG, font=F_SUB)
    t = "TxLINE on Solana"
    d.text((RIGHT - text_w(d, t, F_SUB), fy), t, fill=COLORS["gold_deep"], font=F_SUB)
    return img

def render_duel(job):
    # kickoff / upcoming: two big crests, VS, odds boxes, market note
    img, d = base(job)
    badge_row(d, job)
    if job.get("centerText"):
        f = mono(26)
        d.text(((W - text_w(d, job["centerText"], f)) // 2, 78), job["centerText"], fill=COLORS["gold"], font=f)
    big = 88
    hl, al = load_crest(job["home"].get("logo"), big), load_crest(job["away"].get("logo"), big)
    cy = 122
    if hl: img.paste(hl, (W // 2 - big - 90, cy), hl)
    if al: img.paste(al, (W // 2 + 90, cy), al)
    vs = mono(30)
    d.text(((W - text_w(d, "VS", vs)) // 2, cy + big // 2 - 18), "VS", fill=MUTED_FG, font=vs)
    t = f"{job['home']['name'].upper()} - {job['away']['name'].upper()}"[:34]
    d.text(((W - text_w(d, t, F_TEAM)) // 2, cy + big + 12), t, fill=FG, font=F_TEAM)
    stat_boxes(d, 288, job.get("stats", []))
    if job.get("note"):
        d.rounded_rectangle([LEFT, 372, RIGHT, 414], radius=8, fill=SURFACE)
        d.text((LEFT + 18, 383), job["note"][:92], fill=MUTED_FG, font=sans("Medium", 14))
    footer(d)
    return img

def render_fulltime(job):
    img, d = base(job)
    badge_row(d, {**job, "live": False})
    score_row(img, d, 150, job, logo=52)
    stat_boxes(d, 258, job.get("stats", []))
    if job.get("verified"):
        d.rounded_rectangle([LEFT, 350, RIGHT, 392], radius=8, fill=(20, 45, 40), outline=COLORS["green"], width=1)
        d.line([(LEFT + 18, 371), (LEFT + 25, 378), (LEFT + 38, 361)], fill=COLORS["green"], width=4)
        d.text((LEFT + 50, 361), job["verified"][:64], fill=COLORS["green"], font=sans("Medium", 15))
    if job.get("quote"):
        d.text((LEFT, 404), ('"' + job["quote"]["text"] + '"')[:88], fill=MUTED_FG, font=F_QUOTE)
    footer(d)
    return img

def render_shootout(job):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, BAND - 1, H], fill=col(job["home"].get("color"), MUTED))
    d.rectangle([W - BAND, 0, W, H], fill=col(job["away"].get("color"), MUTED))
    badge_row(d, {**job, "live": False})
    score_row(img, d, 130, job, logo=48)
    marks_font = mono(26)
    rows = (job.get("shootout") or {}).get("rows", [])
    for i, (team, marks) in enumerate(rows[:2]):
        y = 244 + i * 48
        d.text((W // 2 - 170, y), team[:3].upper(), fill=FG, font=sans("Bold", 20))
        for j, m in enumerate(marks[:10]):
            sym = "●" if m == "x" else "○" if m == "o" else "—"
            c = COLORS["gold"] if m == "x" else (MUTED_FG if m == "o" else MUTED)
            d.text((W // 2 - 90 + j * 44, y - 3), sym, fill=c, font=marks_font)
    stat_boxes(d, 356, job.get("stats", []))
    footer(d)
    return img

RENDERERS = {"big": render_big, "mini": render_mini, "duel": render_duel,
             "fulltime": render_fulltime, "shootout": render_shootout}

def main():
    job = json.load(sys.stdin)
    img = RENDERERS[job.get("kind", "big")](job)
    out = job["out"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.convert("RGB").save(out)
    print(out)

if __name__ == "__main__":
    main()
