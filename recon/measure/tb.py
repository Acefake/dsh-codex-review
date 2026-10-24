from PIL import Image
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px=im.load()
def lum(c): return 0.299*c[0]+0.587*c[1]+0.114*c[2]
def textbbox(x0,y0,x1,y1,thr=95,name=""):
    xs=[];ys=[]
    for y in range(y0,y1):
        for x in range(x0,x1):
            if lum(px[x,y])>thr: xs.append(x);ys.append(y)
    if xs: print(f"{name}: x {min(xs)}-{max(xs)} w{max(xs)-min(xs)+1} | y {min(ys)}-{max(ys)} h{max(ys)-min(ys)+1}")
    else: print(name,"none")
def greenbbox(x0,y0,x1,y1,name=""):
    xs=[];ys=[]
    for y in range(y0,y1):
        for x in range(x0,x1):
            c=px[x,y]
            if c[1]>c[0]+25 and c[1]>90: xs.append(x);ys.append(y)
    if xs: print(f"{name}(green): x {min(xs)}-{max(xs)} w{max(xs)-min(xs)+1} | y {min(ys)}-{max(ys)} h{max(ys)-min(ys)+1}")
    else: print(name,"none")
def redbbox(x0,y0,x1,y1,name=""):
    xs=[];ys=[]
    for y in range(y0,y1):
        for x in range(x0,x1):
            c=px[x,y]
            if c[0]>c[1]+30 and c[0]>90: xs.append(x);ys.append(y)
    if xs: print(f"{name}(red): x {min(xs)}-{max(xs)} w{max(xs)-min(xs)+1} | y {min(ys)}-{max(ys)} h{max(ys)-min(ys)+1}")
    else: print(name,"none")
textbbox(2140,150,2330,210,95,"ReviewWithCodex")
textbbox(470,160,640,210,95,"Summary")
textbbox(650,160,780,210,95,"Changes-tab")
greenbbox(790,160,880,210,"+2117")
redbbox(880,160,960,210,"-25")
textbbox(1860,360,2000,400,95,"24 files")
greenbbox(2000,360,2100,400,"+2117-right")
textbbox(1820,700,2050,745,90,"No comments")
textbbox(1855,320,2600,360,95,"Open+badge")
greenbbox(660,315,790,365,"Open-text")
textbbox(600,280,1700,340,95,"PR-title-full")
textbbox(600,540,1800,620,95,"title-meta?")
textbbox(640,720,1800,760,95,"body-line-a")
textbbox(1140,1420,2000,1510,95,"composer-placeholder")
textbbox(2280,340,2420,380,95,"stack-title1")
textbbox(60,55,320,115,95,"sidebar-header")
textbbox(230,150,700,215,95,"searchtext")
