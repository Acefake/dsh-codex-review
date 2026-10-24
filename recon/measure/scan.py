from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB")
W,H = im.size
def runs_line(y, tol=6, minrun=8):
    px = im.load()
    out=[]; start=0; prev=px[0,y]
    for x in range(1,W):
        c=px[x,y]
        if max(abs(c[i]-prev[i]) for i in range(3))>tol:
            if x-start>=minrun: out.append((start,x-1,prev))
            start=x; prev=c
    if W-start>=minrun: out.append((start,W-1,prev))
    return out
def runs_col(x, tol=6, minrun=8):
    px=im.load(); out=[]; start=0; prev=px[x,0]
    for y in range(1,H):
        c=px[x,y]
        if max(abs(c[i]-prev[i]) for i in range(3))>tol:
            if y-start>=minrun: out.append((start,y-1,prev))
            start=y; prev=c
    if H-start>=minrun: out.append((start,H-1,prev))
    return out
print("=== HORIZONTAL RUNS (x ranges of solid color) ===")
for y in [10, 40, 100, 130, 175, 185, 250, 300, 460, 600, 900, 1300, 1440, 1500]:
    print(f"-- y={y}")
    for a,b,c in runs_line(y):
        print(f"   x {a:4d}-{b:4d} w={b-a+1:4d} rgb{c}")
print("=== VERTICAL RUNS ===")
for x in [10, 70, 140, 480, 1500, 1780, 2400, 2540]:
    print(f"-- x={x}")
    for a,b,c in runs_col(x):
        print(f"   y {a:4d}-{b:4d} h={b-a+1:4d} rgb{c}")
