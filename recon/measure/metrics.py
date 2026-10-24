from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load()
def rows_with_text(x0,x1,y0,y1,thr=110,name=""):
    print(f"### {name} region x{x0}-{x1} y{y0}-{y1}")
    bands=[]; inb=False; s=0; last=None
    for y in range(y0,y1):
        cnt=sum(1 for x in range(x0,x1) if px[x,y][0]>thr and abs(px[x,y][0]-px[x,y][2])<40)
        if cnt>=2:
            if not inb: inb=True; s=y
            last=y
        else:
            if inb: bands.append((s,last,last-s+1)); inb=False
    if inb: bands.append((s,last,last-s+1))
    for b in bands: print("   band y",b)
rows_with_text(600,1400,280,380,110,"PR title")
rows_with_text(470,760,160,215,120,"tabs text")
rows_with_text(120,400,165,400,110,"sidebar item1 title")
rows_with_text(1860,2100,240,275,80,"right label Changes")
rows_with_text(1860,2100,320,370,80,"right 24 files")
rows_with_text(640,1800,540,640,110,"body line")
rows_with_text(640,1800,700,800,110,"body line2")
rows_with_text(580,760,510,560,110,"h2 做了什么")
rows_with_text(1740,2000,1430,1505,110,"composer text")
rows_with_text(90,300,60,110,110,"sidebar header 代码审查")
rows_with_text(660,760,320,360,90,"Open badge")
