from PIL import Image
from collections import Counter
p = r"C:\Users\10228\.dsh\attachments\v1\objects\2b\2bd0e6be35481a2e4381a5ed3928e286802660c40f8187084bad745f7fb0d9f0"
im = Image.open(p).convert("RGB"); px = im.load(); W,H = im.size

def bbox_color(x0,y0,x1,y1,pred,name):
    xs=[];ys=[]
    for y in range(y0,y1):
        for x in range(x0,x1):
            if pred(px[x,y]): xs.append(x); ys.append(y)
    if xs:
        print(f"{name}: x {min(xs)}-{max(xs)} (w {max(xs)-min(xs)+1}) y {min(ys)}-{max(ys)} (h {max(ys)-min(ys)+1})")
    else: print(name,"none")

near = lambda c,t,tol=3: all(abs(c[i]-t[i])<=tol for i in range(3))
print("--- geometry ---")
bbox_color(0,300,78,700, lambda c: abs(c[0]-45)<=2 and abs(c[1]-45)<=2, "nav_active_pill(rgb45)")
bbox_color(78,120,434,400, lambda c: abs(c[0]-45)<=2 and abs(c[1]-45)<=2, "sidebar_selected_card(rgb45)")
bbox_color(78,120,434,210, lambda c: c[0]>36 and c[0]<48 and abs(c[0]-c[2])<=2, "search_pill")
bbox_color(430,140,820,215, lambda c: abs(c[0]-45)<=3 and abs(c[1]-45)<=3, "segmented_container(rgb45)")
bbox_color(450,145,620,210, lambda c: c[0]>50 and c[0]<62, "summary_active_pill")
bbox_color(1960,140,2140,215, lambda c: abs(c[0]-45)<=3, "review_btn?")
bbox_color(2120,140,2380,215, lambda c: c[0]>=40, "review_btn_bright")
bbox_color(2380,140,2560,215, lambda c: c[0]>200, "merge_btn_white")
bbox_color(560,290,780,350, lambda c: c[1]>c[0]+8, "open_badge_greenish")
bbox_color(0,0,2560,60, lambda c: c[0]>40, "titlebar_controls")
print("--- key colors ---")
pts = {
 "titlebar_bg":(1200,20),"rail_bg":(10,1000),"rail_active_bg":(39,440),
 "sidebar_bg":(150,1200),"sidebar_card_bg":(300,200),"sidebar_plain_bg":(300,900),
 "search_bg":(200,170),"search_text":(150,168),
 "main_bg":(900,1200),"seg_container":(700,180),"seg_active":(500,180),
 "merge_btn":(2450,175),"merge_text":(2470,178),
 "review_btn":(2200,160),"review_btn_edge":(2130,177),
 "open_badge_bg":(640,320),"open_badge_text":(700,318),
 "divider_main_right":(2544,600),"scrollbar_thumb":(2547,400),
 "chat_bar_bg":(1700,1480),"plus_btn":(1740,1480),
 "h2_text":(600,560),
}
for k,(x,y) in pts.items(): print(k, px[x,y])
