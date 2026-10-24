from PIL import Image
from collections import Counter
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load()
def lum(c): return 0.299*c[0]+0.587*c[1]+0.114*c[2]
def bands(x0,x1,y0,y1,f,minc=2,thr=60):
    out=[];inb=False;s=0;last=0
    for y in range(y0,y1):
        cnt=0
        for x in range(x0,x1):
            if f(px[x,y]): cnt+=1
        if cnt>=minc:
            if not inb: inb=True;s=y;last=y
            else: last=y
        else:
            if inb: out.append((s,last));inb=False
    if inb: out.append((s,last))
    return out
def xext(x0,x1,y0,y1,f):
    xs=[]
    for y in range(y0,y1):
        for x in range(x0,x1):
            if f(px[x,y]): xs.append(x)
    return (min(xs),max(xs)) if xs else None
bright=lambda c: lum(c)>70
print("== RIGHT PANEL line bands (x1860-2340) ==")
for b in bands(1860,2340,230,1000,bright,3):
    ext=xext(1860,2340,b[0],b[1]+1,bright)
    print("  y",b,"x",ext,"h",b[1]-b[0]+1)
print("== TOOLBAR line bands (x440-2560) ==")
for b in bands(440,2560,155,205,bright,3):
    print("  y",b)
print("== GREEN/RED pixels anywhere in toolbar band y155-205 ==")
g=[];r=[]
for y in range(155,206):
    for x in range(440,2560):
        c=px[x,y]
        if c[1]>c[0]+30 and c[1]>100: g.append((x,y,c))
        if c[0]>c[1]+30 and c[0]>100: r.append((x,y,c))
from collections import Counter
print(" green sample:", Counter([c for _,_,c in g]).most_common(3), "count",len(g))
print(" red sample:", Counter([c for _,_,c in r]).most_common(3), "count",len(r))
print("== BADGE row y230-290 x560-800 ==")
for b in bands(560,800,225,300,lambda c: lum(c)>60,2):
    print("  y",b)
print("== badge green pixels ==")
g2=Counter()
for y in range(225,300):
    for x in range(560,800):
        c=px[x,y]
        if c[1]>c[0]+25 and c[1]>90: g2[c]+=1
print("  ",g2.most_common(5))
