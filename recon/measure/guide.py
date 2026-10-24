from PIL import Image, ImageDraw
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB")
d = ImageDraw.Draw(im)
for x in [78,436,660,1693,1800,1866,2315,2528,2560]:
    d.line([(x,0),(x,1528)], fill=(255,0,0) if x in (660,1800) else (0,255,255), width=2)
for y in [66,1434,1497]:
    d.line([(0,y),(2560,y)], fill=(0,255,0), width=2)
im.resize((1280,764), Image.LANCZOS).save(r"C:\Users\10228\dsh-codex-review\recon\crops\overview_guides.png")
print("ok")
