from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB")
out = r"C:\Users\10228\dsh-codex-review\recon\crops"
sub = {
 "03a_toolbar_left":  (430,130,1250,235, 2),
 "03b_toolbar_right": (1780,130,2560,235, 2),
 "05a_right_top":     (1780,230,2560,480, 2),
 "05b_right_bottom":  (1780,460,2560,760, 2),
 "11_open_badge":     (560,290,1000,360, 4),
}
for name,(x0,y0,x1,y1,s) in sub.items():
    c = im.crop((x0,y0,x1,y1))
    c = c.resize((c.width*s, c.height*s), Image.LANCZOS)
    c.save(f"{out}\\{name}.png"); print(name, c.size)
