from PIL import Image
from collections import Counter
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load()
def vext(x0,x1,pred,name):
    ys=[]
    for y in range(0,1528):
        for x in range(x0,x1):
            if pred(px[x,y]): ys.append(y); break
    print(name, (min(ys),max(ys),max(ys)-min(ys)+1) if ys else None)
vext(2544,2552, lambda c: c==(60,60,60), "main scrollbar thumb")
vext(424,432, lambda c: c==(46,46,46) or c==(60,60,60), "sidebar thumb")
print("gradient above composer x=2000:", [(y,px[2000,y]) for y in range(1360,1440,10)])
print("orange icons:", Counter([px[x,y] for y in range(1435,1495) for x in range(2280,2470) if px[x,y][0]>px[x,y][2]+40 and px[x,y][0]>120]).most_common(4))
print("badge green-tinted bbox:")
xs=[];ys=[]
for y in range(225,300):
    for x in range(560,1000):
        c=px[x,y]
        if c[1]>c[0]+8 and c[1]>c[2]+5: xs.append(x);ys.append(y)
print("  ", (min(xs),min(ys),max(xs),max(ys)) if xs else None)
# sidebar card geometry: rows where x=250 is 45,45,45
ys=[y for y in range(140,1200) if px[250,y]==(45,45,45)]
print("sidebar card rows at x=250:", ys[:3], ys[-3:] if ys else None, "count",len(ys))
# search pill rows
ys=[y for y in range(120,240) if px[250,y]==(45,45,45)]
print("search+card rows x250 y120-240:", ys[:3], ys[-3:] if ys else None)
# sidebar item boundaries: scan col x=120 for non-1b1b1b runs
prev=None;runs=[];s=0
for y in range(140,1528):
    c=px[120,y]; key=c!=(27,27,27)
    if prev is None: prev=key;s=y
    elif key!=prev:
        if y-s>4: runs.append((s,y-1,prev))
        prev=key;s=y
print("sidebar col x=120 non-bg runs:", runs)
