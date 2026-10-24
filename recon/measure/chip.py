from PIL import Image
from collections import Counter
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load()
# locate chip horizontal extent on a body line containing inline code: line y 700..760 native
cnt=Counter()
for y in range(696,760):
    for x in range(700,1800):
        c=px[x,y]
        if c!=(24,24,24) and c[0]<80: cnt[c]+=1
print("dark non-bg colors in body band:", cnt.most_common(6))
# chip vertical extent at x where bg found
for y in range(690,770):
    pass
# print a row profile at y=735
row=[]
for x in range(700,1200,4):
    row.append((x,px[x,735]))
print(row[:40])
