# -*- coding: utf-8 -*-
"""生成《苍穹对决》安卓版应用图标：各密度 PNG（RGBA）+ 自适应图标 XML。
纯标准库实现（zlib 手写 PNG），3x3 超采样抗锯齿。"""
import os, zlib, struct

ROOT = r'C:\Users\15522\Downloads\新建文件夹 (2)\安卓版\app\src\main\res'

# 战机俯视轮廓（108×108 坐标系，机头朝上）
JET = [(54,16),(61,46),(94,64),(94,73),(61,62),(61,80),(74,90),(74,97),
       (54,90),(34,97),(34,90),(47,80),(47,62),(14,73),(14,64),(47,46)]

def in_poly(x, y, poly):
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if x < xin:
                inside = not inside
    return inside

def rounded_rect_cov(x, y, S, r):
    """返回点是否在圆角方形内"""
    cx = min(max(x, r), S - r); cy = min(max(y, r), S - r)
    dx = x - cx; dy = y - cy
    return dx * dx + dy * dy <= r * r

def lerp(a, b, t): return a + (b - a) * t
def mix(c1, c2, t): return tuple(lerp(c1[i], c2[i], t) for i in range(3))

def sample(px, py, S):
    """返回该点的 RGBA（0-255），px/py 为像素内坐标"""
    if not rounded_rect_cov(px, py, S, S * 0.22):
        return (0, 0, 0, 0)
    t = py / S
    # 画面：天空（上）→ 地平线浅色（0.60）→ 海（下）
    if t < 0.60:
        col = mix((0.42, 0.72, 0.94), (0.82, 0.91, 0.97), t / 0.60)
    else:
        col = mix((0.18, 0.42, 0.58), (0.09, 0.24, 0.36), (t - 0.60) / 0.40)
    # 太阳光晕
    dsx, dsy = px - S * 0.76, py - S * 0.20
    d = (dsx * dsx + dsy * dsy) ** 0.5
    if d < S * 0.20:
        col = mix(col, (1.0, 0.97, 0.86), (1 - d / (S * 0.20)) * 0.75)
    # 战机（白色机身 + 浅蓝座舱）
    scale = S * 0.70 / 108.0
    jx = (px - S * 0.5) / scale + 54.0
    jy = (py - S * 0.42) / scale + 54.0
    if in_poly(jx, jy, JET):
        col = (0.97, 0.99, 1.0)
    if 46 < jx < 62 and 30 < jy < 50:
        col = mix(col, (0.42, 0.68, 0.96), 0.85)      # 座舱
    return (int(col[0] * 255), int(col[1] * 255), int(col[2] * 255), 255)

def render(S, ss=3):
    rows = []
    for y in range(S):
        row = bytearray()
        for x in range(S):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) / ss
                    py = y + (sy + 0.5) / ss
                    c = sample(px, py, S)
                    r += c[0]; g += c[1]; b += c[2]; a += c[3]
            n = ss * ss
            row += bytes((r // n, g // n, b // n, a // n))
        rows.append(row)
    return rows

def write_png(path, S, rows):
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', S, S, 8, 6, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

DENS = [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]
for name, S in DENS:
    d = os.path.join(ROOT, f'mipmap-{name}')
    os.makedirs(d, exist_ok=True)
    write_png(os.path.join(d, 'ic_launcher.png'), S, render(S))
    print('生成', f'mipmap-{name}/ic_launcher.png', S, 'x', S)

# ---------- 自适应图标（API 26+）----------
d = os.path.join(ROOT, 'mipmap-anydpi-v26'); os.makedirs(d, exist_ok=True)
open(os.path.join(d, 'ic_launcher.xml'), 'w', encoding='utf-8', newline='\n').write(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
    '    <background android:drawable="@drawable/ic_launcher_background" />\n'
    '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n'
    '</adaptive-icon>\n')
print('生成 mipmap-anydpi-v26/ic_launcher.xml')

d = os.path.join(ROOT, 'drawable'); os.makedirs(d, exist_ok=True)
# 背景：天空到海的竖向渐变
open(os.path.join(d, 'ic_launcher_background.xml'), 'w', encoding='utf-8', newline='\n').write(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n'
    '    <gradient android:angle="270"\n'
    '        android:startColor="#6BB8F0" android:centerColor="#CFE8F8" android:endColor="#1B4E6E"\n'
    '        android:type="linear" />\n'
    '</shape>\n')
# 前景：战机剪影（108 视口，落在 72 安全区内）
path_d = "M54,20 L61,50 L94,68 L94,77 L61,66 L61,84 L74,94 L74,101 L54,94 L34,101 L34,94 L47,84 L47,66 L14,77 L14,68 L47,50 Z"
open(os.path.join(d, 'ic_launcher_foreground.xml'), 'w', encoding='utf-8', newline='\n').write(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
    '    android:width="108dp" android:height="108dp"\n'
    '    android:viewportWidth="108" android:viewportHeight="108">\n'
    '    <path android:fillColor="#F7FBFF" android:pathData="' + path_d + '" />\n'
    '    <path android:fillColor="#6BA9F5" android:pathData="M48,34 L60,34 L58,54 L50,54 Z" />\n'
    '</vector>\n')
print('生成 drawable/ic_launcher_background.xml + ic_launcher_foreground.xml')
