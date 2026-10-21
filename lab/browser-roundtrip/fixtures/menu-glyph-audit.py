"""WebGL-free ink audit: python3 menu-glyph-audit.py OUTPUT_DIRECTORY.

Pillow/FreeType and system Arial approximate the browser's sans-serif rasterizer.
This measures atlas texels, not Quest framebuffer coverage or physical comfort.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
result = {"fontSize": 192, "atlasLineHeight": 304, "rasterizer": "Pillow FreeType", "weights": {}}
sheet = Image.new("RGB", (1100, 460), "#081218")
for row, (weight, filename) in enumerate([( "normal", "Arial.ttf"), ("bold", "Arial Bold.ttf")]):
    font = ImageFont.truetype(str(Path("/System/Library/Fonts/Supplemental") / filename), 192)
    mask = Image.new("L", (228, 304))
    ImageDraw.Draw(mask).text((24, 40), "I", font=font, fill=255)
    box = mask.getbbox()
    mid = (box[1] + box[3]) // 2
    stem = sum(mask.getpixel((x, mid)) >= 128 for x in range(mask.width))
    cap = font.getbbox("H")[3] - font.getbbox("H")[1]
    assert cap >= 304 * .44
    result["weights"][weight] = {"capTexels": cap, "stemTexels": stem, "inkCapFraction": cap / 304}
    # Same requested line, same atlas size. No resampling of the measurement.
    preview = ImageFont.truetype(str(Path("/System/Library/Fonts/Supplemental") / filename), 96)
    ImageDraw.Draw(sheet).text((24, row * 230 + 30), "Claude is listening", font=preview, fill="#f2fdfc")
    ImageDraw.Draw(sheet).text((24, row * 230 + 160), f"{weight}: cap {cap} texels; I stem {stem} texels at 192 px", fill="white")
assert result["weights"]["bold"]["stemTexels"] > result["weights"]["normal"]["stemTexels"]
(out / "glyph-texels.json").write_text(json.dumps(result, indent=2) + "\n")
sheet.save(out / "glyph-audit.png")
print(json.dumps(result))
