from PIL import Image
from collections import Counter
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load()
def dom(x0,y0,x1,y1,name,exclude=None):
    cnt=Counter()
    for y in range(y0,y1):
        for x in range(x0,x1):
            c=px[x,y]
            if exclude and all(abs(c[i]-exclude[i])<=3 for i in range(3)): continue
            cnt[c]+=1
    print(name, cnt.most_common(3))
# divider lines in right panel: scan rows for subtle lighter line
print("== divider candidate rows right panel x1900-2200 ==")
for y in range(300,700):
    vals=[px[x,y] for x in range(1900,2200,7)]
    avg=sum(v[0] for v in vals)/len(vals)
    if 30<avg<70: print("  y",y,"avg",round(avg,1),vals[:6])
print("== merge button dark text ==")
best=[]
for y in range(160,200):
    for x in range(2390,2525):
        c=px[x,y]
        if c[0]<120: best.append(c)
print(Counter(best).most_common(4))
print("== titlebar menu text ==")
dom(150,10,300,45,"menu_text",(32,32,32))
print("== toolbar small icons ==")
dom(1960,160,2120,200,"pin_link_gh",(24,24,24))
print("== review gear divider ==")
for x in range(2320,2352): print("   x",x,px[x,178])
print("== composer placeholder ==")
dom(1900,1450,2300,1485,"placeholder",(54,54,54))
print("== composer icons ==")
dom(2300,1450,2470,1485,"composer_icons",(54,54,54))
print("== inline code chip bbox ==")
# find text with bg 45ish in body
for y in range(690,760):
    row=[px[x,y] for x in range(840,900)]
print("== body text color ==")
dom(650,700,1700,760,"body",(24,24,24))
print("== h2 color ==")
dom(590,525,760,560,"h2",(24,24,24))
print("== branch row ==")
dom(1000,360,1700,395,"branch",(24,24,24))
