from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB")
out = r"C:\Users\10228\dsh-codex-review\recon\crops"
im.crop((1180,275,1650,330)).resize((1880,220),Image.LANCZOS).save(out+r"\17_title_right.png")
im.crop((640,330,1300,390)).resize((1980,180),Image.LANCZOS).save(out+r"\18_author_row.png")
print("ok")
