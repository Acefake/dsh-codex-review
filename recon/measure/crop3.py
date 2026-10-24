from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB")
out = r"C:\Users\10228\dsh-codex-review\recon\crops"
im.crop((2280,0,2560,240)).resize((840,720),Image.LANCZOS).save(out+r"\14_top_right.png")
im.crop((60,50,460,150)).resize((1200,300),Image.LANCZOS).save(out+r"\15_sidebar_header.png")
im.crop((1920,140,2140,215)).resize((880,300),Image.LANCZOS).save(out+r"\16_icon_group.png")
print("ok")
