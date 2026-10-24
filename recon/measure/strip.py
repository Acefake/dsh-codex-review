from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load()
def runs_col(x,y0,y1,tol=6,minrun=3):
    out=[];start=y0;prev=px[x,y0]
    for y in range(y0+1,y1):
        c=px[x,y]
        if max(abs(c[i]-prev[i]) for i in range(3))>tol:
            if y-start>=minrun: out.append((start,y-1,prev))
            start=y;prev=c
    out.append((start,y1-1,prev));return out
print("x=2547 col runs:")
for r in runs_col(2547,60,1528): print("  ",r)
print("x=427 col runs:")
for r in runs_col(427,60,1528): print("  ",r)
print("x=95 col runs (sidebar card):")
for r in runs_col(95,140,420): print("  ",r)
im.crop((2440,50,2560,1528)).resize((240,2956),Image.LANCZOS).save(r"C:\Users\10228\dsh-codex-review\recon\crops\12_right_strip.png")
im.crop((0,480,78,700)).resize((234,660),Image.LANCZOS).save(r"C:\Users\10228\dsh-codex-review\recon\crops\13_nav_active.png")
print("ok")
