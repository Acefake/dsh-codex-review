from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB")
out = r"C:\Users\10228\dsh-codex-review\recon\crops"
crops = {
 "01_chrome_top_left": (0,0,900,260, 2),
 "02_sidebar_list":  (60,120,450,1000, 2),
 "03_main_toolbar":  (430,130,2560,230, 2),
 "04_pr_header":     (430,230,1850,420, 2),
 "05_right_panel":   (1760,220,2560,760, 2),
 "06_bottom_bar":    (1500,1400,2560,1528, 2),
 "07_title_row":     (430,290,1300,400, 3),
 "08_md_body":       (430,400,1800,900, 1),
 "09_nav_rail":      (0,50,80,700, 4),
 "10_bottom_full":   (900,1390,2560,1528, 2),
}
for name,(x0,y0,x1,y1,s) in crops.items():
    c = im.crop((x0,y0,x1,y1))
    if s != 1:
        c = c.resize((c.width*s, c.height*s), Image.LANCZOS)
    c.save(f"{out}\\{name}.png")
    print(name, c.size)
