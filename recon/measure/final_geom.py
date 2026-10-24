from PIL import Image
from collections import Counter
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load()
def lum(c): return 0.299*c[0]+0.587*c[1]+0.114*c[2]
def bbox(x0,y0,x1,y1,name,thr=60):
    xs=[];ys=[]
    for y in range(y0,y1):
        for x in range(x0,x1):
            c=px[x,y]
            if c!=(24,24,24) and lum(c)>thr: xs.append(x);ys.append(y)
    print(f"{name:24s}", (min(xs),min(ys),max(xs),max(ys)) if xs else None)
bbox(436,232,1800,280,"badge_row")
bbox(436,282,1800,340,"title_row")
bbox(436,340,1800,395,"avatar_row")
bbox(436,400,1800,480,"para1")
bbox(436,520,1800,570,"h2_row")
bbox(436,580,1800,650,"list1_row")
bbox(436,660,1800,720,"bullet1_row")
bbox(436,960,1800,1030,"para2")
bbox(436,1400,1800,1528,"bottom_body")
print("divider x extent y=332:", [x for x in range(1800,2560) if px[x,332]==(43,43,43)][:1], [x for x in range(2560-1,1800,-1) if px[x,332]==(43,43,43)][:1])
print("divider y=494:", [x for x in range(1800,2560) if px[x,494]==(43,43,43)][:1], [x for x in range(2559,1800,-1) if px[x,494]==(43,43,43)][:1])
print("divider y=569:", [x for x in range(1800,2560) if px[x,569]==(43,43,43)][:1], [x for x in range(2559,1800,-1) if px[x,569]==(43,43,43)][:1])
# inline code chip bg
print("chip pcm-print sample:", [(x,px[x,742]) for x in range(820,1000,10)])
# composer bbox precise
xs=[];ys=[]
for y in range(1380,1528):
    for x in range(1600,2560):
        if px[x,y]==(54,54,54) or (px[x,y][2]>px[x,y][0]+30 and px[x,y][2]>60): xs.append(x);ys.append(y)
print("composer bbox", (min(xs),min(ys),max(xs),max(ys)))
# blue button bbox
b=[]
for y in range(1400,1528):
    for x in range(2400,2560):
        c=px[x,y]
        if c[2]>c[0]+40 and c[2]>90: b.append((x,y))
print("blue btn bbox", (min(a for a,_ in b),min(c for _,c in b),max(a for a,_ in b),max(c for _,c in b)))
# sidebar scrollbar and item extents
print("sidebar scrollbar x:", [x for x in range(400,440) if px[x,900][0]>40])
print("sidebar item card x extent y=200:", [x for x in range(70,440) if px[x,200]==(45,45,45)][:1], [x for x in range(439,70,-1) if px[x,200]==(45,45,45)][:1])
print("search pill x extent y=170:", [x for x in range(70,440) if px[x,170]==(45,45,45)][:1], [x for x in range(439,70,-1) if px[x,170]==(45,45,45)][:1])
# nav active pill
ys=[];xs=[]
for y in range(380,520):
    for x in range(0,78):
        if px[x,y]==(45,45,45): xs.append(x);ys.append(y)
print("nav pill bbox", (min(xs),min(ys),max(xs),max(ys)))
# segmented control bbox
xs=[];ys=[]
for y in range(140,220):
    for x in range(450,800):
        if px[x,y] in ((45,45,45),(56,56,56)): xs.append(x);ys.append(y)
print("seg bbox", (min(xs),min(ys),max(xs),max(ys)))
