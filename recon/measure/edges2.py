from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load(); W,H=im.size
print("Non-bg pixels in right-panel gap rows (bg=24,24,24):")
for y in [700, 900, 1000, 1100, 1200, 1250, 1300]:
    vals=[]
    for x in range(1700, 1900):
        c=px[x,y]
        if c!=(24,24,24): vals.append((x,c))
    print(y, vals[:40])
print("Bottom bar scan:")
for y in [1420,1440,1450,1460,1470,1480,1490,1500,1520]:
    c=px[1200,y]; c2=px[400,y]; c3=px[2540,y]
    print(y, "x1200",c, "x400",c2, "x2540",c3)
