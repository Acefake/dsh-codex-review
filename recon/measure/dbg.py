from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load()
print("toolbar row samples y=177:")
for x in range(440, 800, 10):
    print(x, px[x,177], end="  |  ")
print()
print("brightest in x780-980 y160-200:")
best={}
for y in range(160,201):
    for x in range(780,980):
        c=px[x,y]
        if c not in best: best[c]=1
        else: best[c]+=1
top=sorted(best.items(), key=lambda kv:-kv[1])[:10]
print(top)
print("green candidates x780-980 y160-200:")
for y in range(160,201):
    for x in range(780,980):
        c=px[x,y]
        if c[1]>120 and c[1]>c[0]+30:
            print("  ",x,y,c); break
    else: continue
    break
