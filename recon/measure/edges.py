from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load(); W,H=im.size
def row(y,x0,x1):
    print(f"-- row y={y} x{x0}..{x1}")
    prev=None; start=x0
    for x in range(x0,x1):
        c=px[x,y]
        key=(c[0]//2, c[1]//2, c[2]//2)
        if prev is None: prev=key; start=x; pc=c
        elif key!=prev:
            if x-start>=3: print(f"   {start}-{x-1} w{x-start} {pc}")
            prev=key; start=x; pc=c
    print(f"   {start}-{x1-1} w{x1-start} {pc}")
def col(x,y0,y1):
    print(f"-- col x={x} y{y0}..{y1}")
    prev=None; start=y0
    for y in range(y0,y1):
        c=px[x,y]; key=(c[0]//2,c[1]//2,c[2]//2)
        if prev is None: prev=key; start=y; pc=c
        elif key!=prev:
            if y-start>=3: print(f"   {start}-{y-1} h{y-start} {pc}")
            prev=key; start=y; pc=c
    print(f"   {start}-{y1-1} h{y1-start} {pc}")
row(80, 1700, 1900)
row(460, 1700, 1900)
col(1790, 40, 800)
col(1810, 40, 800)
col(30, 40, 200)
col(300, 40, 300)
row(70, 60, 500)
row(1400, 400, 1200)
